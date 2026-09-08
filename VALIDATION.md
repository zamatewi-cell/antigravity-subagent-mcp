# 1.4.0 验证记录与工程硬化交付报告

验证日期：2026-09-08  
服务版本：`v1.4.0`  
默认模型：`gemini-3.8-flash-high`

---

## 一、版本演进与修复全景

本项目经过系统性迭代，已完整解决多代理协同中的所有关键阻碍：

| 版本 | 核心增强与修复范围 | 对应验证手段 |
| :--- | :--- | :--- |
| **v1.0.3** | 修复 CLI 日志脱敏遗漏、保留成功结果、临时启动错误自动重试、跨平台基础进程树终止。 | `test/diagnostics.test.mjs`, `test/lifecycle.test.mjs` |
| **v1.1.0** | 实现任务持久化存储（`storage.mjs`），支持原子落盘与服务崩溃后断点恢复与离线审计。 | `test/progress.test.mjs` |
| **v1.2.0** | 实现 Teamwork 级联多代理深度解析，递归深挖子代理 transcript，提炼每个 Worker 的当前步数与活动流水。 | `test/teamwork-smoke.mjs` |
| **v1.2.1** | 实现同目录并发排队锁（`withDirectoryLock`）、真实客户端进度通知（`progressToken`）与 5 级深层嵌套穿透。 | `test/counterexamples.test.mjs` (Test 4~7) |
| **v1.2.2** | 彻底根治完成误判（多工具扫描、否定词与进行时过滤、严禁孤立关键词判断），支持排队任务取消与重启收敛。 | `test/counterexamples.test.mjs` (Test 1~3, 8~12) |
| **v1.3.0** | 独立暗黑极客风 Web 可视化监控看板（HTTP/SSE）、主编排器与子代理矩阵上帝视角、统一生命周期取消控制器（`cancelJob`）。 | `test/dashboard.test.mjs`, `test/cancel-consistency.test.mjs` |
| **v1.3.1** | **系统性工程硬化**：根治“已完成误显运行中”与 Killed 状态反转；拦截独立看板假取消（HTTP 409 防篡改）；根除 DOM XSS 漏洞；收紧 CORS 与日志脱敏；首发终止原因胜出保护；基于 mtime/size 的 transcript 高性能缓存。 | `npm run test:all` (16 项反例 + 7 项看板 + 5 项取消一致性 + 生命周期测试) |
| **v1.3.2** | **状态机与安全终极闭环**：独立看板全状态只读拦截（HTTP 409）；子代理状态机优先级纠偏（killed 绝不漂移，删除二次洗绿）；Host 头与非本地 Origin POST 403 阻断；数据目录统一；真实生产目录锁导出验证。 | `test/cancel-consistency.test.mjs` (Test 4.1), `test/counterexamples.test.mjs` (Test 7, 14), `test/dashboard.test.mjs` (Test 3.2) |
| **v1.3.3** | **1.3.x 终极封板与架构解耦**：<br>1. 两层解析架构彻底根治子代理状态冻结；<br>2. 抽离独立目录锁模块 `src/directory-lock.mjs`；<br>3. 实现真 LRU 机制与 `diskJobsCache` 500 条上限保护；<br>4. 配置 GitHub Actions CI 自动化流水线 (`.github/workflows/ci.yml`)。 | `test/counterexamples.test.mjs` (Test 16~18), `npm run test:offline` (全部 6 套离线套件 100% 通过) |
| **v1.4.0** | **企业级四大核心特性飞跃**：<br>1. **历史任务分页与过滤 (R1)**：`GET /api/jobs` 支持 `page` / `limit` / `state` / `search`，标准化分页响应与无参向后兼容；<br>2. **SSE 差异增量流与 Delta Patching (R2)**：首发 snapshot + 变动事件 (`job_created`/`job_updated`/`job_removed`) + `:keep-alive` 保活，前端内存字典局部打补丁消除全量重刷；<br>3. **原生 SVG Agent DAG 拓扑 (R3)**：有向拓扑元数据注入 (`parentId`/`depth`/`childrenIds`/`nodeType`)，纯原生 SVG 贝塞尔连线与 CSS 呼吸流光；<br>4. **Human-in-the-loop 软介入 (R4)**：子进程 `stdio` 保留，安全 `sendInputToJob` 与 `POST /api/jobs/:id/interact` 接口及前端控制台。 | `test/pagination.test.mjs` (12/12 PASS), `test/sse-delta.test.mjs` (6/6 PASS), `test/dag-topology.test.mjs` (4/4 PASS), `test/hitl.test.mjs` (7/7 PASS), `npm run test:offline` (全部 10 套离线套件 100% 通过) |

---

## 二、离线自动化测试套件

全量测试套件均已通过，测试结果可直接在 CI/本地无头环境中 100% 复现（`npm run test:all`）：

### 1. 专项反例与防伪测试 (`node test/counterexamples.test.mjs`)
- [x] **Test 1**: 步数 ≥ 30 且最后为物理工具（构建/写文件）的活跃任务绝对不误判为 `completed`（保持 `running`）。
- [x] **Test 2**: 涉及求助、指示、请示的 `send_message` 绝对不误判为 `completed`，仅严谨的最终交付报告才判定完成。
- [x] **Test 3**: 工具执行可靠提取详细动作描述（如文件名、命令概览）并覆盖过期的文字摘要。
- [x] **Test 4**: 验证 5 级深层子代理嵌套穿透（`maxDepth >= 8`），全链路解析无截断。
- [x] **Test 5**: 验证服务重启后任务状态一致性与原子持久化，中断任务状态一致纠偏。
- [x] **Test 6**: 验证 `progressToken` 通过 `ctx.mcpReq.notify` 真实推送到 MCP 客户端。
- [x] **Test 7**: 验证同一工作目录下的异步任务通过 `withDirectoryLock` 实现互斥排队串行执行。
- [x] **Test 8**: 验证带有完成词汇但包含否定词（“尚未生成，继续修复”）的任务绝不误判为 `completed`。
- [x] **Test 9**: 验证同一步骤内若既有完成消息又有物理工具调用，坚决判定为 `running`。
- [x] **Test 10**: 验证英文否定与未决语气（"No VICTORY yet; still working"）绝不误判为 `completed`。
- [x] **Test 11**: 验证排队任务（`queued`）通过取消接口可直接短路取消并释放目录锁。
- [x] **Test 12**: 验证服务重启后遗留的 `queued` 任务统一纠偏为 `interrupted`，彻底杜绝挂死假死。
- [x] **Test 13**: 验证真实子代理汇报（包含“已完成 codebase 探索”、“已成功交付并修复了编译告警”）能准确判定为 `completed`，绝不因历史复盘词误伤。
- [x] **Test 14**: 验证被明确终止的子代理裁决为 `killed`，彻底修复逻辑反转误标为 completed 的问题。
- [x] **Test 15**: 验证重启纠偏后的 `interrupted` 状态成功原子同步落盘，消除磁盘脏数据。
- [x] **Test 16**: 验证基于文件 `mtime` 和 `size` 的 transcript 底层解析结果缓存与真 LRU 机制，大幅削减每秒广播的重复 I/O。
- [x] **Test 17**: 验证父 transcript 缓存不冻结子代理的实时步数与动作（根治缓存回归，动态穿透）。
- [x] **Test 18**: 验证父任务取消时子代理状态收敛穿透缓存。
- [x] **测试沙箱严格隔离**: 测试均基于 `mkdtempSync` 创建沙箱并动态 `await import` 注入 `process.env.ANTIGRAVITY_MCP_DATA_DIR`，内置 `assert(JOBS_DIR.startsWith(tempDir))` 防御性断言，杜绝 ESM 静态 import 提升导致的生产目录污染。

### 2. 独立实时可视化看板测试 (`node test/dashboard.test.mjs`)
- [x] **Test 1**: 启动轻量原生 HTTP 服务（默认端口 3721，冲突时自增）。
- [x] **Test 2**: 静态单页交付正常，验证现代暗黑前端 HTML 结构完整。
- [x] **Test 3**: `/api/status` 服务状态与指标统计准确无误（版本更新至 1.3.1）。
- [x] **Test 3.1**: CORS 安全访问控制收紧验证，未受信任外部来源绝不反射 `*`，本地合法域正常授权。
- [x] **Test 4**: `/api/jobs` 任务列表与 progress 序列化结构正确。
- [x] **Test 5**: `/api/jobs/:id` 独立任务详情与多子代理矩阵接口正常。
- [x] **Test 5.1**: 物理日志尾部（`logTail`）与诊断错误经过 `sanitizeDiagnostics` 敏感凭据全面脱敏。
- [x] **Test 6**: `POST /api/jobs/:id/cancel` Web 端一键取消排队任务并同步落盘。
- [x] **Test 7**: `GET /api/stream` SSE 实时流广播与连接握手测试通过。

### 3. 统一取消与防假取消测试 (`node test/cancel-consistency.test.mjs`)
- [x] **排队任务取消**：验证立即标记 `stopReason = "cancelled"` 并收敛终态。
- [x] **防状态漂移**：验证运行中任务在触发取消后，底层子进程触发 `close` 事件时，状态保持稳定的 `cancelled`，杜绝被错误改写为 `error`。
- [x] **Dashboard 取消对齐**：验证 Dashboard 取消接口统一复用 `cancelJob` 控制器。
- [x] **独立看板拦截假取消**：验证在独立运行看板（无底层 child 句柄）中试图取消外部运行中任务时，服务端返回 HTTP 409 Conflict，严禁跨进程伪造取消与篡改磁盘。
- [x] **首发终止原因胜出保护**：验证先发生 `timed_out` 或 `output_limit` 的任务，后续 `cancelJob` 不得覆盖其真实错误原因。

### 4. 历史任务服务端分页与过滤单测 (`node test/pagination.test.mjs`)
- [x] **Test 1~2**: 验证无参及无关参数请求平滑向后兼容返回裸数组 `JobDetail[]`。
- [x] **Test 3~4**: 验证 `page=2&limit=5` 精确返回第 6~10 条数据及完整 `pagination` 元数据；末页场景 `hasMore=false`。
- [x] **Test 5**: 验证 `state=running` 单状态精准过滤。
- [x] **Test 6~7**: 验证 `search` 对 Prompt 内容及 Job ID 的大小写不敏感模糊检索。
- [x] **Test 8**: 验证 `state` + `search` + `page` + `limit` 多条件组合过滤与切片。
- [x] **Test 9~12**: 验证防御性边界：超页数优雅返回空数组；非法参数安全降级；limit 范围自适应截断（1~100）；空任务列表优雅处理。

### 5. SSE 细粒度增量事件广播单测 (`node test/sse-delta.test.mjs`)
- [x] **Test 1**: 验证客户端首连时即时派发 `event: connected` 握手与带 `seq` 的首屏快照 `event: snapshot`。
- [x] **Test 2**: 验证无变动周期仅发送轻量 `:keep-alive\n\n`，彻底消除全量大 JSON 广播开销。
- [x] **Test 3**: 模拟任务步数与动作递增，验证精确派发 `event: job_updated` 增量事件与变动字段对齐。
- [x] **Test 4**: 验证动态新增任务与删除任务的 `event: job_created` 和 `event: job_removed` 广播。
- [x] **Test 5**: 验证客户端携带 `Last-Event-ID` 重连握手时，从环形历史缓冲区中精准回放缺失增量。
- [x] **Test 6**: 验证客户端通过内存字典 `jobsById` 进行 Delta Patching 局部打补丁后，数据状态与服务端 100% 收敛。

### 6. 原生 Agent DAG 拓扑架构单测 (`node test/dag-topology.test.mjs`)
- [x] **Test 1**: 验证单层子代理的 DAG 拓扑元数据装配（`parentId`、`depth=1`、`childrenIds`、`nodeType: "worker"`）。
- [x] **Test 2**: 验证多层级 DAG 拓扑结构（Root -> Sub-Orchestrator [depth 1] -> Workers [depth 2]）的父子链与 depth 递归计算。
- [x] **Test 3**: 验证递归深度超出 `maxDepth` 限制时的优雅安全截断与动作标记保护。
- [x] **Test 4**: 验证 `getTaskProgress` 导出的 Agent DAG 拓扑元数据与 REST 接口契约 100% 对齐。

### 7. Human-in-the-loop 软介入通信管道单测 (`node test/hitl.test.mjs`)
- [x] **Test 1**: 验证底层 `sendInputToJob` 安全写入管道与末尾换行符自动补全。
- [x] **Test 2**: 验证 HTTP `POST /api/jobs/:id/interact` 正常下发交互指令，200 响应并成功注入子进程 stdin。
- [x] **Test 3**: 验证终态任务（success / cancelled / error）安全阻断软介入并返回 HTTP 400 Bad Request。
- [x] **Test 4**: 验证非受信任外部 Origin 跨站发起软介入时被严格拦截（HTTP 403 Forbidden）。
- [x] **Test 5**: 验证非法请求体（缺少 input 或格式错误）的防御性参数校验拦截（HTTP 400）。
- [x] **Test 6**: 验证独立看板只读模式下拒绝软介入并返回 HTTP 400。
- [x] **Test 7**: 验证子进程管道关闭或 EPIPE 异常触发时，宿主主进程不崩溃且被妥善兜底捕获。

---

## 三、真实环境端到端验证

| 测试场景 | 验证结果 | 核心指标与审计证据 |
| :--- | :--- | :--- |
| **标准 MCP 协议任务启动** | SUCCESS | 调用 `start_gemini_task` 生成全局 Job ID，后台拉起独立无头 `agy.exe` 进程。 |
| **Teamwork 级联多代理启动** | SUCCESS | 成功拉起 Project Sentinel、Top Orchestrator 与专项 Worker，并在 transcript 中核对到 `invoke_subagent`。 |
| **Web 看板微观上帝视角呈现** | SUCCESS | 使用 Playwright 自动化渲染 `http://localhost:3721`，主编排器卡片、子代理卡片矩阵与 Step 1~72+ 全量活动流水毫秒级实时联动。 |

---

## 四、安全与系统边界

1. **文件访问控制**：工作目录上下文在提示词与指令级别生效，不等于 Linux 命名空间或容器级别的硬隔离。
2. **进程树清理**：本地进程树清理在 Windows 上通过 `taskkill /PID <pid> /T /F`、在 Unix 上通过进程组信号强杀，确保本地孤儿进程完全清理，但不跨越物理宿主机。
3. **并发安全**：针对同一目录的任务强制排队互斥执行；不同目录任务允许并发推进。
