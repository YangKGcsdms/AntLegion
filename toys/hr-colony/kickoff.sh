#!/usr/bin/env bash
# 用例一开球：1 条岗位需求 + 3 份合成简历（红线：全部虚构，候选人用代号）。
set -euo pipefail
AL="npx -y -p @antlegion/bus alctl"

echo "→ 用人经理发布岗位需求"
$AL publish hr.hire.request '{"position":"后端工程师（分布式方向）","team":"基础设施组","headcount":1,"requirements_brief":"Go 或 Java，3 年以上，有消息队列/存储系统经验优先"}' --author hiring-manager@synthetic

sleep 8   # 给 jd-writer 一点时间出 JD（非必需，只为观感）

echo "→ 三份合成简历投递"
$AL publish hr.candidate.applied '{"code":"C-001","position":"后端工程师（分布式方向）","resume":"5 年 Go 后端；自研过基于 Raft 的配置中心；维护过日均 20 亿条的 Kafka 集群；开源项目 800 star"}' --author job-board@synthetic
$AL publish hr.candidate.applied '{"code":"C-002","position":"后端工程师（分布式方向）","resume":"3 年平面设计；精通 Photoshop 与品牌视觉；转行意愿强烈"}' --author job-board@synthetic
$AL publish hr.candidate.applied '{"code":"C-003","position":"后端工程师（分布式方向）","resume":"2 年 Java CRUD 业务开发；用过 RocketMQ 但未深入；学习能力强，刷过 MIT 6.824 公开课"}' --author job-board@synthetic

echo "✓ 已开球。看戏：http://127.0.0.1:28090/console?type=hr.*"
echo "  链条会停在 hr.hire.recommendation —— 裁决是你的（发 hr.offer.approved）"
