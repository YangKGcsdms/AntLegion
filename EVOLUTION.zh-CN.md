<!-- lang-nav --> 🌐 [English](EVOLUTION.md) · **简体中文**

# 演进笔记 —— 运行时为何被砍掉

本文记录主干为何从一个「5-Agent 协作平台」收敛为「总线 + MCP 适配器」。后来者有权
知道试过什么、为什么放弃。

## 最初的野心(v0,现存于 `archive/legacy-emergent-runtime`)

第一版交付了:

- `antlegion-bus/` —— 事实总线(保留在主干)
- `antlegion/` —— 一个 3000 行的 TypeScript 运行时,启动单个 Agent、在总线上注册它,
  并跑 sense → triage → LLM → tool-loop 循环
- `antlegion-bus-ui/` —— 一个 Vue 看板
- `workspaces/{product, ui, backend, frontend, tester}/` —— 五个 Agent,各带一份
  SOUL.md(人格)+ role.yaml(发布/认领白名单)+ skills/*.md
- 一个 `start.sh`,用 docker-compose 把这一切拉起来做「自动 SDLC」演示:扔进一个
  Todo CRUD 需求,看五个 Agent 协作产出代码。

总线协议才是那块难而原创的工作;五 Agent SDLC 演示只是看得见的故事。

## 哪里崩了

复盘主干时发现:

1. **致命 bug** 让演示在干净的 Linux 主机上跑不起来(总线 secret 的环境变量名不一致;
   容器内 `USER node` 写不了 root 所有的挂载卷;`start.sh` 每次强制 `--build`;占位的
   LLM key 通过了校验,于是容器在紧凑的重启循环里崩溃)。

2. **任务 ⊥ 机制不匹配。** SDLC 有强偏序(PRD → API → 前端 → 测试)。事实总线是
   *因果但无序* 的介质。运行时试图用 SOUL.md 散文(「你必须同时等到 design.published
   *和* api.published」)把顺序写进去。把顺序写成散文就是把顺序写成「建议」;LLM
   可以无视它,而且确实无视过。

3. **指令自相矛盾。** 运行时注入的 `role-guidance` 段说「不要用 `legion_bus_query`
   轮询」。而每个带门控的 SOUL.md 又说「用 `legion_bus_query` 查另一个前置是否到达」。
   LLM 的遵从度不可预测。

4. **运行时是个封闭生态。** 接入一个外部 Agent(Claude Code、Cursor、Cline、Continue、
   Codex CLI……)需要用它们的语言和运行时重新实现 WebSocket 重连、内容哈希、ant 注册、
   认领语义。没人会去做。「5-Agent SDLC 演示」是唯一的客户端。

5. **没有端到端验证。** 178 个单测通过。零个测试验证「五个 Agent 产出可运行的
   Todo CRUD 应用」这一主张。

## 重新定位

经过两轮结构化自评(记录在评审分支的 PR 历史里),结论是:

> 事实总线才是耐久资产。5-Agent 运行时存在,只因没有外部 Agent 会说这个协议。
> 正确的解法不是「把运行时做得更好」,而是「让协议人人可说」。

MCP(Model Context Protocol)在 2024–2025 成为 LLM 驱动客户端的通用语。到 2026,
Claude Code、Cursor、Cline、Continue、Windsurf、Goose、Codex CLI、Zed 以及 Manus
的开源变体都支持它。一个 MCP 适配器一次性解锁所有这些客户端。

## 我们保留了什么

- `antlegion-bus/` —— 协议。修了 bug(环境变量名、TTL 默认值),并加了基于游标的
  `?since_sequence=N` 查询用于客户端驱动轮询。无破坏性协议改动。
- 双轴状态模型、content_hash 签名、因果链、supersede、corroborate/contradict、
  JSONL 恢复、TTL 清扫、GC、日志压缩。这些是别的事实总线没有的部分。

## 我们砍了什么

- `antlegion/` —— 运行时。退役。其职责(循环、工具调用、会话、事实记忆、上下文缓冲、
  认领守卫、插件)移交给接管总线的任意 MCP 客户端。对 Claude Code 用户「正确」的运行时
  就是 Claude Code;对 Cline 用户就是 Cline。
- `antlegion-bus-ui/` —— 看板。暂时移除。若需要可观测性,一个 MCP 资源
  (`antlegion://stats`)或一个小型只读 HTML 页比 Vue SPA 便宜。
- `workspaces/{product, ui, backend, frontend, tester}/` —— 五个 SOUL.md Agent。退役。
  上文的理由(任务 ⊥ 机制不匹配)意味着我们不相信这种协作模型能靠散文跑通。若要重访
  「靠事实协调的 Agent」,我们会从单一角色起步、做端到端验证,等单一角色稳定产出有用
  结果后再泛化。
- `start.sh`、`submit-task.sh`、`watch.sh` —— 被 `docker compose up` 加客户端侧配置取代。
- `FACT-FLOW.md`、`PROJECT_SUMMARY.md` —— SDLC 叙事。README 现在承载更小的新故事。
- `antlegion-bus/DESIGN.md`、`antlegion-bus/PROGRESS.md` —— 旧运行时耦合时代的设计与
  阶段跟踪;有用的协议内容已并入根 [PROTOCOL.md](PROTOCOL.md)。
- `antlegion-bus/protocol/{SPEC, EXTENSIONS, IMPLEMENTATION-NOTES}`(六个文件,中英文)——
  合并进根部统一的 [PROTOCOL.md](PROTOCOL.md)。
- `docs/` 子目录。所有文档现在都在项目根部以便发现。

## 旧代码在哪

```
git checkout archive/legacy-emergent-runtime
```

或浏览:https://github.com/YangKGcsdms/antlegion-platform/tree/archive/legacy-emergent-runtime

该分支被刻意冻结,不再修 bug。它的存在是为了溯源:若未来的贡献者想看试过什么、
想复活某个想法,源码就在那里。

## 继承下来的原则

1. **总线协议是神圣的。** 对 facts、签名、状态机、REST 端点的改动会破坏每一个客户端。
   把它们当作线格式,遵循正常的协议版本化卫生。
2. **复杂度由适配器承载。** 客户端本来要知道的一切——哈希、token、语义类型、因果深度——
   都住在 `antlegion-mcp/` 或其未来的兄弟里,不在客户端可见表面。
3. **对事实存储,轮询优于推送。** 总线暴露游标,客户端自定节奏。我们不会重新加回
   per-ant 的 WebSocket 推送。
4. **主干上无编排器。** 若某用例需要严格的工作流排序,那种编排是客户端的问题,不是总线的。
   总线提供 `exclusive` 模式与 `subject_key` supersede,这就是它会提供的协调。
5. **没有 e2e 测试,就不声称「生产就绪」。** 在有一个绿色 CI 任务、用真实客户端打真实
   总线并对可度量结果做断言之前,README 措辞保持「alpha」。

---

## 附记(2026):v1 → v2,一元论重构

对 v1 的复盘发现:它的表面又宽又虚——每条事实约 30 个字段、两套服务端状态机、五个
扩展——而且相当一部分「Stable」特性(优先级老化、高级仲裁、schema 治理、per-ant 事件
推送)从未被运行中的总线、或唯一的真实客户端(MCP 适配器,它甚至不注册 ant)真正触发。
对一个想做*标准*的项目,这个落差是致命的:运行的代码才是事实标准,「文档有、实现没有」
会摧毁接入者的信任。

于是 v2 从**唯一本原**重新推导:全序中一条不可变、内容寻址的事实。两个操作——`append`
与 `read`。其余一切(工作流状态、信任、独占认领、取代、因果)都成为对事实流的**读者折叠**,
而非服务端状态。总线退化为无状态可信内核(赋序、校验内容哈希、盖可信时间并签名、持久化、
按区间返回);「智能」搬进每种语言只写一次的客户端折叠库。

这买到了什么:
- **实现 == 规范。** 服务端只有几百行;第二个实现是一个周末的事,由跨语言一致性向量守护。
- **可靠性是结构性的。** 日志*就是*状态,崩溃恢复就是一次截断;恰好一次的独占性是全序的
  定理,而非某把锁的实现。
- **v1 的缺陷被消解,而非打补丁:** GC 不再断因果链(tombstone 保留骨架)、自动 supersede
  成了读者策略(无静默脚枪)、claim 在重启后存活,死掉的仲裁/事件代码直接消失。

难的部分搬了家,而非消失:意义如今住在**折叠规则**(`PROTOCOL.md` §3,规范性),因此它们
必须精确、并被一致性测试覆盖——而用约 20 个 Agent 的 swarm 压测(`antlegion-bus/examples/`)
正是逼出并修掉了其中最棘手一处(以 recv 锚定的认领超时,使崩溃恢复重派不会被陈旧的 owner
阻塞)的方式。

v1 被保留(`antlegion-bus/src/`、`antlegion-mcp/`、`PROTOCOL-v1-historical.md`),因为
MCP 适配器仍是 MCP 客户端零代码接入的唯一路径。v2 的 MCP 适配器是计划中的桥。
