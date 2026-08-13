# hr-colony — 用例一：一条自治的招聘链（S4 场景实弹）

**5 只 pi agent + 1 个人类闸门**，跑通"岗位需求 → JD → 简历初筛 → 技术面试 → 委员会建议 → 【人工批 offer】→ 入职任务扇出"的完整链条。全部合成数据，候选人以代号为主体（S4 红线）。

## 为什么这事单个 agent 干不了

1. **多方本来就隔离**：用人经理、初筛、面试官、委员会、IT/行政各是不同的人/权限域——现实里它们之间的"协调层"就是 HRBP 在群里转述
2. **中间夹着人类裁决**：offer 审批必须是人。单 agent 会话没法挂起三天等审批；板上的事实可以永远等——人批下来（`hr.offer.approved` 落板）,下游自己醒
3. **并行竞争**：多份简历同时进来,恰好一次保证每份只被筛一次
4. **审计是 HR 的刚需**：为什么拒了 C-003？谁批的 offer？——因果链免费回答,零查询成本

## 编制

| agent | 听 | 产 | 备注 |
|---|---|---|---|
| jd-writer@hr | hr.hire.request | hr.jd.ready | |
| screener@hr | hr.candidate.applied | hr.candidate.screened | 严格筛人 |
| interviewer@hr | screened **且 `"pass":true`** | hr.interview.feedback | **条件监听**——被筛掉的不占面试官时间 |
| committee@hr | hr.interview.feedback | hr.hire.recommendation | 停在人类门前 |
| onboarding-planner@hr | **hr.offer.approved**（人发） | hr.onboard.plan | IT/行政/HRBP/经理任务扇出 |
| 👤 HRBP | 读 recommendation | 发 hr.offer.approved | **裁决类触点,保留给人**（评估宪章 M1） |

## 玩法

```bash
DEEPSEEK_API_KEY=sk-… docker compose up --build -d
./kickoff.sh                                   # 1 岗位 + 3 份合成简历
open "http://127.0.0.1:28090/console?type=hr.*"

# 链条停在 hr.hire.recommendation —— 该你裁决了：
npx -y -p @antlegion/bus alctl publish hr.offer.approved \
  '{"code":"C-001","level":"P6","note":"批准"}' --author hrbp@human
# onboarding-planner 随即产出入职任务清单
```

## 首次实弹记录（2026-08-13,全链 ~60 秒）

- C-001（Raft/Kafka 老兵）：过筛 → 面试 8 分 → 委员会建议 offer P6 → 人工批准 → 入职清单（IT D-3 开账号备电脑、行政 D-3 工位、HRBP D-1 合同……）
- C-002（平面设计师）：初筛拒——"背景完全不符"；**面试官从未看过这份简历**（条件监听）
- C-003（CRUD 两年）：初筛拒——"仅浅用 MQ,无分布式实战"（够严格）

宪章视角：这条链上的**中继触点为 0**（没有任何一步需要人转述状态）,**裁决触点恰好 1**（offer 审批）——正是 M1 的目标形态。

## 下一个用例（待启动）

S4 设计稿里的**薪资链**（precheck → 对账差异阻断发薪 → 财务门 → settled）——"恰好一次"最要命的场景（双跑结算=事故),也是注入实验（认领后崩溃）的最佳标本。
