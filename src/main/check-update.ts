
import { app, dialog } from "electron";
import { spawn } from "node:child_process";
import {
    createWriteStream
} from "node:fs";
import {
    mkdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
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

        // 下载更新包
        const installerPath = await downloadInstaller(
            downloadUrl,
            headers
        );

        // 启动安装
        await installUpdate(installerPath);

    } catch (err) {
        console.error("自动更新失败", err);

        await dialog.showMessageBox({
            type: "warning",
            title: "自动更新失败",
            message: "更新过程中发生错误",
            detail: err instanceof Error
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

    const response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10 * 60 * 1000)
    });

    if (!response.ok || !response.body) {
        throw new Error(
            `下载更新包失败：HTTP ${response.status}`
        );
    }

    await pipeline(
        Readable.fromWeb(response.body as any),
        createWriteStream(tempPath)
    );

    const fileStat = await stat(tempPath);

    if (fileStat.size <= 0) {
        throw new Error("下载的更新包为空");
    }

    await rm(installerPath, { force: true });

    await rename(tempPath, installerPath);

    console.log(
        `自动更新：下载完成，大小 ${fileStat.size} 字节`
    );

    return installerPath;
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

        await dialog.showMessageBox({
            type: "error",
            title: "更新失败",
            message: "无法启动安装程序",
            detail: err.message
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

        await dialog.showMessageBox({
            type: "info",
            title: "更新完成",
            message: "程序已成功更新",
            detail: `当前版本：${app.getVersion()}`
        });

    } catch {
        // 没有更新标记，不需要提示
    }
}
