# API 设计（Socket.io 事件）

> 服务端 `handlers/*.ts` 注册，事件前缀与模块对应。全部鉴权（socket.data.auth）+ 公司隔离（companyId 归属校验）。返回 `{ ok, data }` 或 `{ ok:false, error }`。

## 需求 requirement
| 事件 | 载荷 | 返回 |
|------|------|------|
| `req:list` | `{ companyId, projectId? }` | `{ requirements: Req[] }` |
| `req:create` | `{ companyId, projectId?, title, description?, category?, priority?, handlerId?, startTime?, dueTime?, taskIds? }` | `{ requirement }` |
| `req:update` | `{ id, ...可改字段 }` | `{ requirement }` |
| `req:status` | `{ id, status, note }` | `{ requirement }` |
| `req:delete` | `{ id }` | `{ ok }` |
| `req:linkTasks` | `{ id, taskIds }` | `{ linkedTaskIds }` |

Req 类型：
```ts
{ id, companyId, projectId, code, title, description, category, priority, status,
  handlerId, creatorId, startTime, dueTime, completedTime, linkedTaskIds, createdAt, updatedAt,
  handlerName?, creatorName? }
```

## 缺陷 bug
| 事件 | 载荷 | 返回 |
|------|------|------|
| `bug:list` | `{ companyId, projectId? }` | `{ bugs }` |
| `bug:create` | `{ companyId, projectId?, requirementId?, title, description?, severity?, priority?, handlerId?, foundVersion? }` | `{ bug }` |
| `bug:update` | `{ id, ... }` | `{ bug }` |
| `bug:status` | `{ id, status, note }` | `{ bug }` |
| `bug:delete` | `{ id }` | `{ ok }` |

## 计划 plan
| 事件 | 载荷 | 返回 |
|------|------|------|
| `plan:list` | `{ companyId, projectId? }` | `{ plans }` |
| `plan:create` | `{ companyId, projectId?, name, description?, startTime?, dueTime? }` | `{ plan }` |
| `plan:update` | `{ id, ... }` | `{ plan }` |
| `plan:delete` | `{ id }` | `{ ok }` |

## 文档 document
| 事件 | 载荷 | 返回 |
|------|------|------|
| `doc:list` | `{ companyId, projectId? }` | `{ docs }` |
| `doc:create` | `{ companyId, projectId?, title, content? }` | `{ doc }` |
| `doc:update` | `{ id, title?, content? }` | `{ doc }` |
| `doc:delete` | `{ id }` | `{ ok }` |

## Wiki
| 事件 | 载荷 | 返回 |
|------|------|------|
| `wiki:list` | `{ companyId, projectId? }` | `{ pages }` |
| `wiki:create` | `{ companyId, projectId?, title, content? }` | `{ page }` |
| `wiki:update` | `{ id, title?, content? }` | `{ page }` |
| `wiki:delete` | `{ id }` | `{ ok }` |

## 聚合（仪表盘 / 成员跟踪）
| 事件 | 载荷 | 返回 |
|------|------|------|
| `pm:dashboard` | `{ companyId, projectId? }` | `{ stats }` |
| `pm:memberTracking` | `{ companyId, projectId? }` | `{ members }` |

## 权限校验（handler 内）
- 公司角色：`owner`/`admin` 可 create/update/status/delete；`member` 仅 list + 作为处理人可流转。
- 所有写入前校验 `companyId` 归属：`store.getMemberRole(companyId, userId)` 非空才放行。
