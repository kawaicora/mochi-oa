
import { app, BrowserWindow, webContents } from "electron";
import { notify } from "./notif";
import { spawn } from "node:child_process";
import {
    mkdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile
} from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";

// 修改为你项目中 loadServerConfig 的实际导入路径
import { loadServerConfig } from "./server-config";

interface ServerConfig {
    serverUrl: string;
    token?: string;
}

interface UpdateInfo {
    version: string;
    downloadUrl: string;
    sha256?: string;
}

const UPDATE_DIR = "mochi-update";
const INSTALLER_NAME = "update.exe";
const SUCCESS_FLAG = "update-success.flag";

// 下载“长时间无响应”判定（毫秒）：安装包可达数百 MB，这里不设整体硬超时，
// 只在流式传输中断流（长时间收不到任何字节）时才中止，避免大文件被固定超时误杀。
const NO_RESPONSE_TIMEOUT = 2 * 60 * 1000;

// 主进程 → 渲染进程的更新进度 / 状态事件通道（渲染层 UpdateProgressOverlay 订阅）
const UPDATE_PROGRESS_EVENT = "update:event:progress";
const UPDATE_STATE_EVENT = "update:event:state";

/** 把事件推送给所有打开的渲染窗口（登录窗/主窗都算）。 */
function broadcastUpdate(channel: string, payload: unknown): void {
    for (const wc of webContents.getAllWebContents()) {
        wc.send(channel, payload);
    }
}

let updatePromise: Promise<void> | null = null;

/**
 * 检查更新并执行安装。
 *
 * 可以在应用启动后调用：
 *
 * await checkUpdateJoin();
 *
 * 重复调用时不会同时执行多个更新流程。
 */
export function checkUpdateJoin(): Promise<void> {
    if (updatePromise) {
        return updatePromise;
    }

    updatePromise = checkUpdate()
        .finally(() => {
            updatePromise = null;
        });

    return updatePromise;
}

/**
 * 检查服务器版本并执行更新。
 */
async function checkUpdate(): Promise<void> {
    const cfg: ServerConfig = loadServerConfig();

    if (!cfg.serverUrl) {
        console.log("自动更新：未配置服务器地址");
        return;
    }

    const serverUrl = cfg.serverUrl.replace(/\/+$/, "");

    const headers: Record<string, string> = {};

    if (cfg.token) {
        headers.Authorization = `Bearer ${cfg.token}`;
    }

    try {
        console.log("自动更新：检查服务器版本");
        console.debug(`自动更新：服务器地址 ${serverUrl}/files/version`);
        const response = await fetch(
            `${serverUrl}/files/version`,
            {
                method: "GET",
                headers,
                signal: AbortSignal.timeout(15000)
            }
        );

        if (!response.ok) {
            throw new Error(
                `版本检查失败：HTTP ${response.status}`
            );
        }

        const update = await response.json() as UpdateInfo;

        if (!update.version || !update.downloadUrl) {
            throw new Error("服务器返回的更新信息不完整");
        }

        const currentVersion = app.getVersion();

        const latestVersion = semver.valid(update.version);
        const localVersion = semver.valid(currentVersion);

        if (!latestVersion || !localVersion) {
            throw new Error(
                `版本号无效：本地=${currentVersion}，服务器=${update.version}`
            );
        }

        if (!semver.gt(latestVersion, localVersion)) {
            console.log(
                `自动更新：当前已是最新版本 ${currentVersion}`
            );
            return;
        }

        console.log(
            `自动更新：发现新版本 ${currentVersion} -> ${latestVersion}`
        );
        console.debug(`自动更新：下载地址 ${update.downloadUrl}`);
        // 解析服务器下载地址
        const downloadUrl = new URL(
            update.downloadUrl,
            serverUrl
        ).toString();

        // 通知渲染层：发现新版本，开始下载
        broadcastUpdate(UPDATE_STATE_EVENT, {
            state: "downloading",
            version: latestVersion,
            message: `发现新版本 ${latestVersion}，开始下载更新包…`
        });

        // 下载更新包
        const installerPath = await downloadInstaller(
            downloadUrl,
            headers
        );

        // 通知渲染层：下载完成，准备安装
        broadcastUpdate(UPDATE_STATE_EVENT, {
            state: "installing",
            version: latestVersion,
            message: "下载完成，正在启动安装…"
        });

        // 启动安装
        await installUpdate(installerPath);

    } catch (err) {
        console.error("自动更新失败", err);

        broadcastUpdate(UPDATE_STATE_EVENT, {
            state: "error",
            message: err instanceof Error ? err.message : String(err)
        });

        notify({
            kind: "system",
            title: "自动更新失败",
            body: err instanceof Error
                ? err.message
                : String(err)
        });
    }
}

/**
 * 下载 NSIS 安装包。
 */
async function downloadInstaller(
    url: string,
    headers: Record<string, string>
): Promise<string> {

    const dir = join(
        app.getPath("temp"),
        UPDATE_DIR
    );

    await mkdir(dir, { recursive: true });

    const tempPath = join(dir, "update.tmp");
    const installerPath = join(dir, INSTALLER_NAME);

    await rm(tempPath, { force: true });

    console.log("自动更新：开始下载", url);

    // 流式下载：不在整体下载上设置硬超时（安装包可达数百 MB，
    // 固定超时会在正常下载中被意外打断）。仅在“长时间无响应”
    // （超过 NO_RESPONSE_TIMEOUT 没有任何数据到达）时中断。
    const controller = new AbortController();
    const stallTimer = setTimeout(
        () => controller.abort(),
        NO_RESPONSE_TIMEOUT
    );

    let downloaded = 0;

    let response: Response;

    try {
        response = await fetch(url, {
            method: "GET",
            headers,
            signal: controller.signal
        });
    } catch (err) {
        clearTimeout(stallTimer);
        throw classifyDownloadError(err, url);
    }

    if (!response.ok || !response.body) {
        clearTimeout(stallTimer);
        throw new Error(
            `下载更新包失败：HTTP ${response.status} ${response.statusText}`
        );
    }

    const expectedSize = Number(
        response.headers.get("content-length") ?? 0
    );

    // 手动分块读取：既能统计下载进度（推送给渲染层进度条），
    // 又能让“长时间无响应”的 stallTimer 在字节到达时保持不中断。
    const reader = (response.body as any).getReader();
    const fileHandle = await import("node:fs/promises").then(
        (m) => m.open(tempPath, "w")
    );

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            await fileHandle.write(chunk);
            downloaded += chunk.length;
            if (expectedSize > 0) {
                broadcastUpdate(UPDATE_PROGRESS_EVENT, {
                    phase: "download",
                    received: downloaded,
                    total: expectedSize,
                    percent: Math.min(
                        100,
                        Math.round((downloaded / expectedSize) * 100)
                    )
                });
            }
        }
    } catch (err) {
        throw classifyDownloadError(err, url);
    } finally {
        clearTimeout(stallTimer);
        await fileHandle.close().catch(() => {});
        void reader.cancel().catch(() => {});
    }

    const fileStat = await stat(tempPath);

    if (fileStat.size <= 0) {
        throw new Error("下载的更新包为空");
    }

    if (
        expectedSize > 0 &&
        fileStat.size !== expectedSize
    ) {
        await rm(tempPath, { force: true });
        throw new Error(
            `下载的更新包不完整：期望 ${expectedSize} 字节，实际 ${fileStat.size} 字节`
        );
    }

    await rm(installerPath, { force: true });

    await rename(tempPath, installerPath);

    console.log(
        `自动更新：下载完成，大小 ${fileStat.size} 字节`
    );

    return installerPath;
}

/**
 * 将下载过程中的异常归类为对用户友好的中文提示。
 */
function classifyDownloadError(
    err: unknown,
    url: string
): Error {
    if (err instanceof Error && err.name === "AbortError") {
        return new Error(
            `下载更新包超时（长时间无响应）：${url}`
        );
    }

    if (err instanceof Error && "cause" in err) {
        const cause = (err as { cause?: { code?: string } }).cause;
        if (cause && (cause.code === "ECONNREFUSED" || cause.code === "ENOTFOUND")) {
            return new Error(
                `无法连接下载服务器（${cause.code}）：${url}`
            );
        }
        if (cause && cause.code === "ECONNRESET") {
            return new Error(
                `下载连接被重置：${url}，请稍后重试`
            );
        }
    }

    if (err instanceof Error && err.name === "TimeoutError") {
        return new Error(
            `下载更新包超时：${url}`
        );
    }

    return new Error(
        err instanceof Error
            ? `下载更新包失败：${err.message}`
            : `下载更新包失败：${String(err)}`
    );
}

/**
 * 启动静默安装。
 *
 * NSIS 静默参数：/S
 *
 * 安装器需要在当前程序退出后安装。
 */
async function installUpdate(
    installerPath: string
): Promise<void> {

    const flagPath = join(
        app.getPath("userData"),
        SUCCESS_FLAG
    );

    // 标记下一次启动时提示更新完成
    await writeFile(
        flagPath,
        app.getVersion(),
        "utf8"
    );

    console.log("自动更新：启动静默安装");

    const child = spawn(
        installerPath,
        ["/S"],
        {
            detached: true,
            stdio: "ignore",
            windowsHide: true
        }
    );

    child.once("error", async (err) => {
        console.error("自动更新：安装器启动失败", err);

        await rm(flagPath, { force: true });

        notify({
            kind: "system",
            title: "更新失败",
            body: "无法启动安装程序：" + err.message
        });
    });

    child.unref();

    // 退出当前 Electron 程序，释放安装目录中的文件
    app.quit();
}

/**
 * 检查上次更新是否成功。
 *
 * 在 app.whenReady() 中调用。
 */
export async function checkUpdateSuccess(): Promise<void> {
    const flagPath = join(
        app.getPath("userData"),
        SUCCESS_FLAG
    );

    try {
        await readFile(flagPath, "utf8");

        await rm(flagPath, { force: true });

        notify({
            kind: "system",
            title: "更新完成",
            body: `程序已成功更新，当前版本：${app.getVersion()}`
        });

    } catch {
        // 没有更新标记，不需要提示
    }
}
