# SERVER_ADMIN 统一 + 落库 + 建库建表边界 + 管理页 SFU —— 开发计划

> 需求来源：用户第 6/8/9/10/11 条。
> 仓库：服务端 `mochi-oa-server-go`（分支 report-and-erp-support）；客户端 `mochi-oa`（同分支）。
> 状态：**待用户过目确认后实现**。

---

## 〇、需求 6 核查结论（建库 / 建表 / 迁移边界）—— 已满足，无需改代码

> 用户原话：新服务器创建数据库依旧按照最新表的创建并且是服务端执行（这是服务的一部分）；如果数据库已经存在就创建表（外部已建库）；创建数据库是服务端的一部分，但迁移不是。

核查 `internal/db/setup.go`，**现有实现完全符合**：

| 职责 | 归属 | 现状实现 |
|---|---|---|
| 创建数据库 | **服务端启动** | `ensureDatabase()` 用 `CREATE DATABASE IF NOT EXISTS` —— 库不存在才建；**外部已建库则跳过**（IF NOT EXISTS 幂等） |
| 创建/补齐表 | **服务端启动** | `autoMigrateTables()` 用 GORM AutoMigrate 按 Row 结构体建缺失表/补列，不删列不改数据；外部已建库 → 自动补建缺失表 |
| 数据/结构迁移 | **独立工具**（不属于服务端） | `cmd/tools/database_update`；服务端启动**只 AutoMigrate，不内嵌任何 ALTER/ADD 语句** |

- 开关：`AUTO_CREATE_DATABASE` / `AUTO_MIGRATE`（均默认 true，可关掉回退"只读复用现有表"）。
- **与本计划衔接**：需求 9 新增的 `server_admins` 表，将加入 `autoMigrateTables` 的 models 列表，由**服务端启动 AutoMigrate 自动建表**（新表走服务端，无需迁移工具），与需求 6 边界一致。

---

## 一、需求拆解

| 需求 | 内容 | 性质 |
|---|---|---|
| 8 | 统一 SERVER_ADMIN 查询方式 | 重构（消除散落实现） |
| 9 | 创建 SERVER_ADMIN 权限表，后台设置的用户修改写到表而不是重启消失 | 新功能（持久化落库） |
| 10 | 统一获取 SERVER_ADMIN 的方法，复用，不要这里写一次那里写一次 | 重构（收敛单一函数） |
| 11 | 管理页面里面的远程查看客户端、会议功能需要也变成 SFU | 核查/补齐（客户端已 SFU，范围待确认） |

> **现状（已探查）**：SERVER_ADMIN 判定存在 **3 套重复实现**，且判定结果不一致：
> 1. `internal/handlers/rtcdev/rtc.go:111` `isServerAdmin(a, cfg)` —— 只查 `config.ServerAdmins`（环境变量）
> 2. `internal/handlers/auth/auth.go:216` `isServerAdmin(a, cfg)` —— 只查 `config.ServerAdmins`
> 3. `internal/handlers/mailholiday/mail.go:56` `isServerAdminUsername(username, cfg)` —— 查 `config.ServerAdmins` **+ 运行时内存集合 `serverAdminOverrides`**
>
> 后果：`admin:setServerAdmin` 在后台动态增删的管理员只写入**内存 Set**（mail.go:48），
> **重启即丢失**（需求 9 的痛点）；且 rtc.go / auth.go 的判定**看不到**后台动态添加的管理员（权限不一致）。

---

## 二、任务分解与实现步骤

### 任务 A：SERVER_ADMIN 统一判定 + 落库（需求 8/9/10）

**1. 新增权限表 `server_admins`（需求 9）**

| 列 | 类型 | 说明 |
|---|---|---|
| id | BIGINT PK AUTO_INCREMENT | 主键 |
| username | VARCHAR(64) UNIQUE | 管理员用户名（小写存储，判定不区分大小写） |
| created_by | BIGINT | 创建人用户 id |
| created_at | DATETIME(3) | 创建时间（完整格式） |
| updated_at | DATETIME(3) | 更新时间 |

- 表由服务端 GORM AutoMigrate 自动建（`AUTO_MIGRATE=true`），无需手工 SQL。
- 迁移：`cmd/tools/database_update` 增加第 6 步「建/补 server_admins 表」（幂等，`CREATE TABLE IF NOT EXISTS`）。

**2. 新增唯一判定函数（需求 8/10，收敛复用）**

- 新建 `internal/handlers/admin/perm.go`（或 `internal/db/server_admin.go`），提供**唯一入口**：

```go
// 判定某用户（或用户名）是否为 SERVER_ADMIN。
// 规则（合并，命中其一即管理员）：
//   1) 环境变量种子 config.ServerAdmins（SERVER_ADMIN_USERS 优先，回退 ADMIN_USER）
//   2) server_admins 表（后台动态增删，持久化，重启保留）
// 与公司/群角色无关；用户名大小写不敏感。
func IsServerAdminByUsername(username string, cfg *config.ServerConfig, store db.Store) bool
func IsServerAdmin(a *types.Auth, cfg *config.ServerConfig, store db.Store) bool   // 包装 Auth
```

- 判定优先级：**表为权威**（后台增删立即生效、重启保留），config 环境变量作为**初始种子/保底**。
  - 首启把 `config.ServerAdmins` 播种进表（`admin:initSeed` 或判定时懒合并）。
  - 简化方案（推荐，符合"统一/复用"）：**判定 = config.ServerAdmins ∪ server_admins 表**，`admin:setServerAdmin` 写表。
- 内存集合 `serverAdminOverrides`（mail.go）**整体删除**，改走表。

**3. 收敛全部调用点（需求 8/10）**

删除/替换以下三处重复实现，全部改为调唯一函数：
- `internal/handlers/rtcdev/rtc.go:111` 的 `isServerAdmin` → 删，改调统一函数
- `internal/handlers/auth/auth.go:216` 的 `isServerAdmin` → 删，改调统一函数
- `internal/handlers/mailholiday/mail.go:56` 的 `isServerAdminUsername` + `serverAdminOverrides` → 删，改调统一函数

受影响调用点（约 20+ 处，全部换成统一函数，行为一致）：
- `rtcdev/sysmon.go`（系统监控 7 处）、`rtc.go`（管理后台创建房间/查询会议 2 处）、`dev.go`（远程查看 10+ 处）
- `auth/auth.go`（登录 payload serverAdmin 2 处）
- `mailholiday/mail.go`（邮件配置 2 处）、`admin.go`（listUsers/setServerAdmin/listCompanies 等 6 处）

**4. `admin:setServerAdmin` 改写表（需求 9）**

- `internal/handlers/mailholiday/admin.go:150` `admin:setServerAdmin`
  - 当前：写内存 `serverAdminOverrides`
  - 改为：`server_admins` 表 upsert（设） / delete（取消）；写库成功后广播刷新。
- `admin:listUsers` 的 `serverAdmin` 标记：改从统一函数取值（config ∪ 表）。
- 新增 `admin:listServerAdmins`（可选）：返回表内全部管理员，供管理页回显。

**5. 涉及文件（服务端）**

| 文件 | 改动 |
|---|---|
| `internal/db/setup.go` | 注册 `ServerAdminRow` 模型（AutoMigrate） |
| `internal/db/server_admin.go`（新） | 表模型 + List/Upsert/Delete 方法 |
| `internal/db/store.go` | Store 接口加 3 个方法 |
| `internal/handlers/admin/perm.go`（新） | 唯一判定函数 `IsServerAdmin*` |
| `internal/handlers/auth/auth.go` | 删本地 isServerAdmin，改统一函数 |
| `internal/handlers/rtcdev/rtc.go` | 删本地 isServerAdmin，改统一函数 |
| `internal/handlers/rtcdev/sysmon.go` / `dev.go` | 调用改统一函数 |
| `internal/handlers/mailholiday/mail.go` | 删 serverAdminOverrides + isServerAdminUsername，改统一函数 |
| `internal/handlers/mailholiday/admin.go` | setServerAdmin 写表；listUsers 标记改统一函数 |
| `cmd/tools/database_update/main.go` | 迁移加第 6 步（建 server_admins 表，幂等） |
| `build.ps1` / `build.sh` | 若新增独立 cmd 无需改；迁移工具已在 dist |

### 任务 B：管理页远程查看/会议 SFU 核查（需求 11）

- **已确认**：Electron 客户端 `RtcEngine.ts` 已全 SFU（LiveKit 订阅，无 P2P 信令）；远程查看 `openRemoteWindow` 走服务端签发的 SFU token；`dev.go`/`rtc.go` 会议/远程已返回 token。服务端保留 SDP 中继仅为兼容旧客户端。
- **待确认**：你说的"管理页面"具体指哪个界面？
  1. Electron 客户端菜单里的管理/后台页面（远程查看列表 + 会议入口）—— **已 SFU**
  2. 浏览器访问的网页后台（`oa.kawaimoe.org` 的 admin 页面）—— 若仍在 P2P，需改 SFU（找到该页面代码后按 RtcEngine 同款接入）
- 确认后，若为 (2)，再补充该页面的 SFU 改造子任务（任务分解另行列出）。

---

## 三、验收标准

### 任务 A（SERVER_ADMIN 统一 + 落库）
1. `server_admins` 表 AutoMigrate 自动创建；迁移工具第 6 步幂等可重复执行。
2. 后台 `admin:setServerAdmin` 设/取消管理员后**重启容器**，权限**保留**（不再消失）。
3. 后台新增的管理员能访问远程查看/系统监控/邮件配置等 SERVER_ADMIN 功能（此前 rtc.go/auth.go 判定看不到）。
4. 环境变量 `SERVER_ADMIN_USERS` / `ADMIN_USER` 种子仍生效（合并进判定）。
5. 全仓库**只剩一个** SERVER_ADMIN 判定函数（`grep isServerAdmin` 无重复实现）。
6. `go build ./...`、`go vet ./...` 通过；两端 git 提交。

### 任务 B（SFU 核查）
- 依确认结果验收（若已 SFU 则复测远程查看/会议走 LiveKit token；若为网页后台则改后复测）。

---

## 四、待确认（请过目拍板）

1. **需求 11 的"管理页面"指**：(a) Electron 客户端管理界面（已 SFU，无需改） 还是 (b) 网页后台（需 SFU 改造）？若为 (b)，请提供网页后台入口/地址。
2. **SERVER_ADMIN 判定语义**：推荐"环境变量种子 ∪ 数据库表"，后台增删写表、重启保留。是否接受？还是希望"以表为唯一权威，环境变量仅首启播种"？
3. 是否需要 `admin:listServerAdmins` 接口（管理页回显当前管理员）？

确认后我开始实现（服务端 8/9/10 为主），每步 git 提交。
