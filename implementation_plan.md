# 实施方案 (implementation_plan.md)

## 项目背景
Antigravity Subagent MCP 与 Web Dashboard 面向高并发、多智能体任务执行提供可视化与控制中枢。当前版本在处理百级以上历史任务、高频实时通信以及深度子代理层级时，面临全量轮询 I/O 压力大、SSE 冗余快照占用高、缺少直观 DAG 连线以及无法向运行中进程介入输入等痛点。本次 1.4.0 版本体系旨在通过阶段化演进解决上述问题。

## 技术选型
1. **服务端架构与存储**：Node.js ESM (`src/dashboard.mjs`, `src/progress.mjs`, `src/storage.mjs`, `src/process-control.mjs`)，复用基于内存的 LRU 缓存与文件系统轻量持久化。
2. **通信协议与增量传输**：Server-Sent Events (SSE)，引入细粒度事件流 (`snapshot`, `job_created`, `job_updated`, `job_removed`, `:keep-alive`) 与版本序列号机制。
3. **前端渲染与交互**：原生 HTML5 + SVG，零外部庞大重量级库，轻量纯粹，实现呼吸光效与拓扑有向图。
4. **测试框架与沙箱隔离**：Node.js 原生测试套件/自定义断言，动态 `await import` 配合临时目录沙箱，强约束 `JOBS_DIR.startsWith(tempDir)`。

## 实施步骤
1. **Phase 0: 调查与规格对齐 (Survey) [已完成]**
   - 调度 spec_miner 提取全部需求与接口断言。
   - 调度 Explorer 勘测后端存储/路由/测试沙箱及前端 Dashboard 机制。
   - 产出统一架构规划 `PROJECT.md`。
2. **Phase 1: 历史任务分页与 SSE 增量广播 (M1, M2) [已完成]**
   - M1: 重构 `GET /api/jobs`，支持 `page`, `limit`, `state`, `search`，标准化分页返回结构与向后兼容。
   - M2: 重构 `GET /api/stream`，支持首次 snapshot 与细粒度差异广播；前端 Delta patching 局部打补丁。
3. **Phase 2: 原生 SVG Agent DAG 拓扑架构 (M3) [已完成]**
   - 在 `src/progress.mjs` 中预埋 `parentId`, `depth`, `childrenIds`, `nodeType`。
   - 前端原生 SVG 拓扑连线与呼吸光效呈现。
4. **Phase 3: Human-in-the-loop 软介入通信管道 (M4) [已完成]**
   - 在 `src/process-control.mjs` 中封装 `sendInputToJob(job, input)`，EPIPE 防御。
   - Dashboard 提供 `POST /api/jobs/:id/interact` 接口与安全校验。
5. **Phase 4: 全量离线验证与发布 (M5) [已完成]**
   - 编写并执行隔离单测与全量离线回归套件 `npm run test:offline`（10/10 全绿通过）。
   - 更新 `package.json` 至 1.4.0，同步更新 `README.md` 与 `VALIDATION.md`。
   - 审计与完备性验证，提交最终交付。

## 风险评估与对策
1. **风险：全量读取磁盘引起高频 I/O 阻塞**
   - 对策：充分复用已有 LRU 缓存机制，在内存维护任务元数据索引，按需加载任务详情。
2. **风险：SSE 客户端重连导致事件丢失或状态不一致**
   - 对策：携带版本/游标序列号 `seq`，首次连接或重连主动请求完整快照，后续走增量流。
3. **风险：子进程写入 stdin 发生 EPIPE 崩溃**
   - 对策：严格校验 `childProcess.stdin.writable` 与监听 `error` 事件，安全降级返回。
4. **风险：测试污染生产数据**
   - 对策：所有测试脚本严守动态导入与临时目录沙箱，入口强校验 `assert(JOBS_DIR.startsWith(tempDir))`。
