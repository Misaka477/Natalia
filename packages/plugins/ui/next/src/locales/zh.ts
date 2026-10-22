/**
 * The shell's common dictionary. zh-CN is the key-set source of truth:
 * `en` is checked complete against `CommonKey`, so a missing or extra
 * English key is a compile error. Keys are dot-namespaced
 * (`<domain>.<object>`); templates carry `{name}` placeholders.
 *
 * This first slice covers the shell chrome of the extracted regions
 * (topbar, right rail tabs, sidebar, common actions). The inventory
 * grows as each region converts; the guard test asserts every `t()` key
 * used in source exists here.
 */

export const zh = {
  // common actions and words
  "common.ok": "确定",
  "common.cancel": "取消",
  "common.close": "关闭",
  "common.search": "搜索",
  "common.settings": "设置",
  "common.more": "更多",
  "common.status": "状态",
  "common.help": "帮助",
  "common.stash": "暂存",
  "common.sandbox": "沙箱",
  "common.plugins": "插件",
  "common.retry": "重试",
  "common.delete": "删除",
  "common.save": "保存",
  "common.edit": "编辑",
  "common.expand": "展开",
  "common.collapse": "收起",
  "common.selectAll": "全选",
  "common.archive": "归档",
  "common.restore": "恢复",
  "common.create": "新建",
  "common.add": "添加",
  "common.browse": "浏览…",
  "common.copy": "复制",
  "common.loading": "加载中…",
  "common.unknown": "未知",
  // topbar
  "topbar.view": "视图",
  "topbar.search": "搜索",
  "topbar.settings": "设置",
  "topbar.more": "更多",
  "topbar.close": "关闭",
  "topbar.left": "左栏",
  "topbar.right": "右栏",
  "topbar.navi": "Navi",
  "topbar.language": "语言",
  // right rail tabs
  "tab.diff": "审阅 / Diff",
  "tab.plan": "计划",
  "tab.governance": "治理",
  "tab.nia": "Nia",
  "tab.agent": "协同",
  // sidebar
  "sidebar.workspace": "工作区",
  "sidebar.sessions": "会话",
  "sidebar.search": "搜索会话",
  "sidebar.searchSessions": "搜索会话...",
  "sidebar.moreSessionActions": "更多会话操作",
  "sidebar.bulkSelect": "批量选择",
  "sidebar.newSession": "新建会话",
  "sidebar.addWorkspace": "添加工作区",
  "sidebar.selectedCount": "已选 {count} 项",
  "sidebar.sessionActions": "会话操作",
  "sidebar.showArchived": "显示归档",
  "sidebar.parallelRunning": "并行中",
  "sidebar.parallelSessions": "并行会话",
  "sidebar.rename": "重命名",
  "sidebar.workspaceActions": "工作区操作",
  "sidebar.workspaceSettings": "工作区设置",
  "sidebar.deleteWorkspace": "删除工作区",
  "sidebar.clickToRestore": "点击恢复",
  "sidebar.restoreSession": "恢复会话",
  "sidebar.archiveSession": "归档会话",
  "sidebar.expandRestSessions": "展开其余 {count} 个会话",
  // workbench
  "workbench.expandRight": "展开右侧栏（Ctrl+J）",
  "workbench.collapseLeft": "展开左侧栏（Ctrl+B）",
  // pending and queue
  "input.messagePlaceholder": "输入消息，使用 @ 提及文件…",
  "input.chatPlaceholder": "向 Navi 提问…",
  "input.send": "发送",
  "input.stop": "停止",
  "input.attach": "附件",
  "input.rollback.noticeBoth": "已还原会话到所选消息，并恢复了工作区检查点。",
  "input.rollback.noticeWorkspace": "已恢复工作区检查点。",
  "input.rollback.noticeSafety": "已还原会话到所选消息，并创建了安全后悔点。",
  "input.rollback.noticeMessages":
    "已还原会话到所选消息。没有可用的文件检查点，因此未恢复工作区更改。",
  "modals.workspaceAddUnsupported":
    "当前 runtime 不支持 workspaceAdd，请确认连接的是 Natalia runtime serve",
  // transcript panes
  "transcript.emptyMainTitle": "Natalia 已准备好",
  "transcript.emptyMainHint": "Natalia 会直接处理工作区任务。",
  "transcript.emptyChatTitle": "向 Navi 提问",
  "transcript.emptyChatHint": "Navi 用于规划和审查，不直接操作工作区。",
  "transcript.jumpToBottom": "跳到底部",
  "transcript.goalDoneTitle": "目标已完成——清除后可设定新目标",
  "transcript.goalDone": "✓ 完成",
  "transcript.goalPause": "暂停（停止当前轮，稍后可继续）",
  "transcript.goalResume": "继续（开启新一轮）",
  "transcript.goalEditTitle": "编辑 goal 目标 / 轮次上限",
  "transcript.goalClearTitle": "清除 goal",
  "transcript.goalLabel": "目标",
  "transcript.goalCapLabel": "轮次上限",
  "transcript.goalCapHint": "留空=不改，0=无限",
  "transcript.timingUnknown": "计时未知",
  "transcript.selectModel": "选择模型",
  "transcript.reasoningEffort": "推理强度",
  "transcript.configLoadFailedRetry": "配置加载失败，点击重试",
  "transcript.configLoadFailed": "配置加载失败",
  "transcript.selectPermission": "选择权限",
  "transcript.rollbackPrepared": "已准备回滚：{label}",
  "transcript.rollbackEffectiveOnSend": "发送新消息后生效",
  "transcript.rollbackRedoHint": "发送新消息前可以重做这些更改",
  "transcript.redo": "重做",
  "transcript.acknowledged": "知道了",
  "transcript.chatModel": "Chat 模型",
  "transcript.chatReasoning": "Chat 推理",
  "transcript.expertModel": "专家模型",
  "transcript.expertReasoning": "专家推理",
} satisfies Record<string, string>;

/** The shell's common key set. */
export type CommonKey = keyof typeof zh;
