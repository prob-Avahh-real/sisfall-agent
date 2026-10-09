// 帕金森病（PD）行动最小集与行为边界 —— 本项目的单一范围契约。
//
// 功能增删以本文件的集合为准；test/pd-scope.test.js 强制：(a) 结构完整，
// (b) 所有用户可见输出文本不含 FORBIDDEN_TERMS（诊断/处方/疗效语言）。
//
// 依据（要点转述）：
// - NICE NG71（2017，现行版）：1.7.2 早期即应转诊有 PD 经验的物理治疗师做
//   评估、教育与身体活动建议；1.7.3 对出现平衡或运动功能问题者提供
//   PD 特异性物理治疗；并与"老年人跌倒"指南联动，建议补充维生素 D。
// - MDS 物理治疗循证综述（Keus 等, 2015）：物理治疗用于步态、平衡、转移
//   与体能；提示策略（cueing）用于步态冻结。
// - AAN：物理治疗/运动训练作为低风险干预列入 PD 管理选项。
// - 《中国帕金森病治疗指南（第四版）》（中华医学会神经病学分会帕金森病
//   及运动障碍学组，2020）：康复与运动治疗是 PD 全程管理的组成部分，
//   含平衡、力量与节律提示训练。
//
// 体位性低血压（OH）方向：PD 常见合并症（自主神经功能障碍、药物相关），
// 是晕厥与跌倒的重要机制。agent 在此方向只做三件事：
//   ①「起身发晕」签到（体位相关症状，权重最高的症状项）；
//   ② 起身/转移的分步口令（坐稳 → 缓慢站 → 站稳再迈）与诱因窗口提示
//      （服药后、饭后、天热时更需放慢）；
//   ③ 把上述内容写进护理建议与训练口令。
// 正式评估与处置（血压测量、药物调整、水盐/压力袜等）属于临床——见边界。

export const PD_SOURCES = [
  { id: 'nice-ng71', org: 'NICE', title: "Parkinson's disease in adults (NG71)", items: '1.7.2 早期转诊 PD 专科物理治疗；1.7.3 平衡/运动功能问题的 PD 特异性物理治疗；维生素 D 与跌倒指南联动' },
  { id: 'mds-pt-review', org: 'MDS', title: "Physiotherapy for Parkinson's disease: EBM review (Keus et al., 2015)", items: '步态、平衡、转移、体能；cueing 策略用于冻结' },
  { id: 'aan', org: 'AAN', title: 'Parkinson disease management guidelines', items: '物理治疗/运动训练为低风险管理选项' },
  { id: 'cn-guideline-4th', org: '中华医学会神经病学分会', title: '中国帕金森病治疗指南（第四版, 2020）', items: '康复与运动治疗为全程管理组成部分；平衡与节律提示训练' },
];

/** 患者行动最小集：agent 只围绕这四类行动提供观察与提醒。 */
export const PD_PATIENT_ACTIONS = [
  { id: 'walk', name: '平地行走', risk: '步幅缩短、节律不稳，冻结高发' },
  { id: 'turn', name: '转身', risk: '冻结与失衡的高发场景' },
  { id: 'sit-to-stand', name: '坐站转移', risk: '姿势反射受损后最常失败的动作；合并体位性低血压（OH）时起身更易发晕' },
  { id: 'stand', name: '站立与重心转移', risk: '姿势不稳是 PD 跌倒的核心机制' },
];

/** agent 行动最小集：允许做且仅允许做的行为。 */
export const PD_AGENT_ACTIONS = [
  { id: 'assess', name: '姿态风险评估与趋势预测', note: '只描述姿态与趋势，不做分期判定' },
  { id: 'cue', name: '提示性提醒（放慢、扶稳、节律）', note: '引导性口令（含起身分步、扶稳、节拍/节律提示），不含治疗指令' },
  { id: 'train', name: '循证训练动作引导（按阶段取库）', note: '每个动作带 evidence 字段' },
  { id: 'medication', name: '服药时间提醒', note: '只是时间闹钟；不含药名、剂量与调整' },
  { id: 'journal', name: '会话日志（供复诊参考）', note: '日志是记录，不是诊断结论' },
];

/** 行为边界：明确不做的事（越界即缺陷）。 */
export const PD_BOUNDARIES = [
  { id: 'no-diagnosis', text: '不做诊断，也不给出 H&Y/UPDRS 等分期评分' },
  { id: 'no-prescription', text: '不涉及药名、剂量与用药调整；服药提醒仅是时间提醒' },
  { id: 'no-emergency', text: '不替代急救：跌倒后持续无应答时提示联系急救与照护者，但不自动呼救' },
  { id: 'no-disease-claims', text: '不声称病情改善或恶化，只描述姿态与行为模式' },
  { id: 'no-treatment-claim', text: '训练动作用于安全的活动练习，不构成治疗方案' },
];

/** 用户可见输出文本的禁用词（诊断/处方/疗效语言）。测试强制扫描。 */
export const FORBIDDEN_TERMS = ['诊断', '处方', '剂量', '加药', '减药', '停药', '治愈', '根治', '确诊', '病情恶化', '好转', '康复了'];
