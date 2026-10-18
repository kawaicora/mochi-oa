/**
 * Mochi OA - IPC 通道常量。
 * 渲染进程经 preload（window.pantry.server*）→ 主进程 server-ipc → serverClient(socket.io)。
 */

/** 渲染 → 主进程 invoke 通道 */
export const IpcChannels = {
  // 连接 / 状态
  serverConnect: 'server:connect',
  serverDisconnect: 'server:disconnect',
  serverState: 'server:state',
  serverGetSettings: 'server:settings:get',
  serverSaveSettings: 'server:settings:save',
  serverSetActiveCompany: 'server:setActiveCompany',
  // 开机自启
  setAutoLaunch: 'app:setAutoLaunch',
  getAutoLaunch: 'app:getAutoLaunch',
  // 远程设备控制（被控端 → 服务端）
  devRegister: 'dev:register',
  devHeartbeat: 'dev:heartbeat',
  devDevices: 'dev:devices',
  devSignal: 'dev:signal',
  devGetInfo: 'dev:info',

  // 账号
  serverRegister: 'server:register',
  serverLogin: 'server:login',
  /** 发送邮箱验证码（注册验证 / 验证码登录） */
  serverSendEmailCode: 'server:sendEmailCode',
  serverSendResetCode: 'server:sendResetCode',
  serverSendResetMail: 'server:sendResetMail',
  serverLogout: 'server:logout',
  /**
   * 切换服务器地址：清掉 token 并断开当前会话 → 渲染层回登录页（新地址不带 token 重连）。
   * 换服务器等于换账号体系，旧 token 对新服务器无意义，必须清。
   */
  serverChangeUrl: 'server:changeUrl',
  // 登录会话（多端）/ 账号安全
  serverSessions: 'server:sessions',
  serverEndSession: 'server:session:end',
  serverEndAllSessions: 'server:session:endAll',
  serverSetSessionDays: 'server:session:setDays',

  // 公司
  serverCompanies: 'server:companies',
  serverCompanyCreate: 'server:company:create',
  serverCompanyJoin: 'server:company:join',
  serverCompanySearch: 'server:company:search',
  serverCompanyLeave: 'server:company:leave',
  serverCompanySetRole: 'server:company:setRole',
  serverCompanyKick: 'server:company:kick',
  serverCompanyAddMember: 'server:company:addMember',
  serverCompanyTransfer: 'server:company:transfer',
  serverCompanyDissolve: 'server:company:dissolve',
  serverUserSearch: 'server:user:search',
  serverDepartments: 'server:departments',
  serverDepartmentCreate: 'server:department:create',
  serverDepartmentAssign: 'server:department:assign',
  serverDepartmentRemoveMember: 'server:department:removeMember',
  serverDepartmentDelete: 'server:department:delete',
  serverMembers: 'server:members',
  serverDepartmentMembers: 'server:department:members',

  // 群
  serverGroups: 'server:groups',
  serverGroupCreate: 'server:group:create',
  serverGroupJoin: 'server:group:join',
  serverGroupSearch: 'server:group:search',
  serverGroupLeave: 'server:group:leave',
  serverGroupKick: 'server:group:kick',
  serverGroupMembers: 'server:group:members',
  serverGroupSetAdmin: 'server:group:setAdmin',
  serverGroupUnsetAdmin: 'server:group:unsetAdmin',
  serverGroupMute: 'server:group:mute',
  serverGroupAdd: 'server:group:add',
  serverGroupInvite: 'server:group:invite',
  serverGroupAcceptInvite: 'server:group:acceptInvite',
  serverGroupDeclineInvite: 'server:group:declineInvite',
  serverGroupTransfer: 'server:group:transfer',
  serverGroupDissolve: 'server:group:dissolve',

  // 会话 / 聊天
  serverConversations: 'server:conversations',
  serverConversationPin: 'server:conversation:pin',
  serverConversationRead: 'server:conversation:read',
  serverChatHistory: 'server:chat:history',
  serverChatSend: 'server:chat:send',
  serverDmHistory: 'server:dm:history',
  serverDmSend: 'server:dm:send',
  serverMessageDelete: 'server:message:delete',
  serverMessageHardDelete: 'server:message:hardDelete',

  // 好友
  serverFriends: 'server:friends',
  serverFriendAdd: 'server:friend:add',
  serverFriendRemove: 'server:friend:remove',

  // 假期（全局日历：法定/调休/自定义，多端同步）
  serverHolidays: 'server:holidays',
  serverHolidayAdd: 'server:holiday:add',
  serverHolidayRemove: 'server:holiday:remove',
  serverHolidayAddMany: 'server:holiday:addMany',
  serverHolidayRemoveMany: 'server:holiday:removeMany',
  serverHolidayReset: 'server:holiday:reset',

  // 任务流程系统
  serverTaskProjects: 'server:task:projects',
  serverTaskProjectCreate: 'server:task:projectCreate',
  serverTaskProjectDelete: 'server:task:projectDelete',
  serverTaskProjectSetRole: 'server:task:projectSetRole',
  serverTaskProjectMembers: 'server:task:projectMembers',
  serverTaskList: 'server:task:list',
  serverTaskDetail: 'server:task:detail',
  serverTaskCreate: 'server:task:create',
  serverTaskUpdate: 'server:task:update',
  serverTaskDelete: 'server:task:delete',
  serverTaskSetStatus: 'server:task:setStatus',
  serverTaskSetReminder: 'server:task:setReminder',
  serverTaskAddAssignment: 'server:task:addAssignment',
  serverTaskRemoveAssignment: 'server:task:removeAssignment',
  serverTaskSetAssignmentStatus: 'server:task:setAssignmentStatus',
  serverTaskComment: 'server:task:comment',
  serverTaskAddIssue: 'server:task:addIssue',
  serverTaskResolveIssue: 'server:task:resolveIssue',
  serverTaskRequestExtension: 'server:task:requestExtension',
  serverTaskDecideExtension: 'server:task:decideExtension',

  // TAPD 项目管理
  serverReqList: 'server:req:list',
  serverReqCreate: 'server:req:create',
  serverReqUpdate: 'server:req:update',
  serverReqStatus: 'server:req:status',
  serverReqDelete: 'server:req:delete',
  serverReqLinkTasks: 'server:req:linkTasks',
  serverBugList: 'server:bug:list',
  serverBugCreate: 'server:bug:create',
  serverBugUpdate: 'server:bug:update',
  serverBugStatus: 'server:bug:status',
  serverBugDelete: 'server:bug:delete',
  serverPlanList: 'server:plan:list',
  serverPlanCreate: 'server:plan:create',
  serverPlanUpdate: 'server:plan:update',
  serverPlanDelete: 'server:plan:delete',
  serverDocList: 'server:doc:list',
  serverDocCreate: 'server:doc:create',
  serverDocUpdate: 'server:doc:update',
  serverDocDelete: 'server:doc:delete',
  serverWikiList: 'server:wiki:list',
  serverWikiCreate: 'server:wiki:create',
  serverWikiUpdate: 'server:wiki:update',
  serverWikiDelete: 'server:wiki:delete',
  serverPmDashboard: 'server:pm:dashboard',
  serverPmMemberTracking: 'server:pm:memberTracking',

  // 日报 / 周报（公司隔离，payload 均带 companyId）
  serverReportCurrent: 'server:report:current',
  serverReportCreate: 'server:report:create',
  serverReportUpdate: 'server:report:update',
  serverReportSubmit: 'server:report:submit',
  serverReportDelete: 'server:report:delete',
  serverReportList: 'server:report:list',
  /** 我收到的（别人发给我的报表，按 recipientIds 匹配本人） */
  serverReportInbox: 'server:report:inbox',
  serverReportTemplateList: 'server:report:template:list',
  serverReportTemplateCreate: 'server:report:template:create',
  serverReportTemplateUpdate: 'server:report:template:update',
  serverReportTemplateDelete: 'server:report:template:delete',
  serverReportStats: 'server:report:stats',

  // 考勤申请（补卡/请假/调休，公司隔离）
  serverAttendanceCreate: 'server:attendance:create',
  serverAttendanceList: 'server:attendance:list',
  serverAttendanceApprove: 'server:attendance:approve',
  serverAttendanceReject: 'server:attendance:reject',
  // 审批流程配置（按类型配审批人/抄送人）
  serverApprovalFlowGet: 'server:approval:flow:get',
  serverApprovalFlowSave: 'server:approval:flow:save',
  serverApprovalFlowList: 'server:approval:flow:list',

  // 打卡（公司隔离）
  serverCheckinCreate: 'server:checkin:create',
  serverCheckinList: 'server:checkin:list',
  serverCheckinSettingsGet: 'server:checkin:settings:get',
  serverCheckinSettingsSave: 'server:checkin:settings:save',
  // 打卡规则（上下班时间/休息/豁免）与当天状态
  serverCheckinRulesGet: 'server:checkin:rules:get',
  serverCheckinRulesSave: 'server:checkin:rules:save',
  serverCheckinStatusGet: 'server:checkin:status:get',
  // 资产管理（企业资源，公司隔离；增删改/流转=admin，列表/详情=成员可读）
  serverAssetCreate: 'server:asset:create',
  serverAssetList: 'server:asset:list',
  serverAssetGet: 'server:asset:get',
  serverAssetUpdate: 'server:asset:update',
  serverAssetDelete: 'server:asset:delete',
  serverAssetFlowCreate: 'server:asset:flow:create',
  serverAssetFlowList: 'server:asset:flow:list',
  // 公司职位系统（公司隔离；增删改/绑定=admin，列表/绑定查询=成员可读）
  serverJobCreate: 'server:job:create',
  serverJobUpdate: 'server:job:update',
  serverJobDelete: 'server:job:delete',
  serverJobList: 'server:job:list',
  serverJobBind: 'server:job:bind',
  serverJobBindings: 'server:job:bindings',
  // 取本机 MAC（main 进程 os.networkInterfaces）
  getMac: 'get:mac',

  // 闹钟：到点执行用户程序/脚本（跨平台，main 进程 spawn）
  alarmRun: 'alarm:run',

  // 文件上传
  serverUpload: 'server:upload',
  /** 分块上传（带进度回调，支持断点续传；完成后返回 {ok,url,...}） */
  serverUploadChunked: 'server:uploadChunked',
  /** 打开系统文件选择框，返回所选文件路径（用于发送图片/文件） */
  filePick: 'file:pick',
  filePickMulti: 'file:pickMulti',
  /** 读取本地文件字节（音频 blob 播放用，绕开 app-file 协议） */
  audioReadFile: 'file:readAudioBytes',
  /** 打开系统文件夹选择框，返回所选目录路径（用于发送文件夹） */
  filePickFolder: 'file:pickFolder',
  /** 递归枚举文件夹内所有文件路径 */
  serverListFolderFiles: 'server:listFolderFiles',
  /** 下载整个文件夹到配置路径（按原结构建目录）：{relPath} */
  serverDownloadFolder: 'server:downloadFolder',
  /** 捕获主屏幕（返回 { dataUrl, width, height }，全分辨率 PNG）用于截屏编辑 */
  fileCaptureScreen: 'file:captureScreen',
  /** 把 dataUrl 写为临时 PNG，返回临时文件路径（截屏编辑后发送用） */
  fileWriteTempImage: 'file:writeTempImage',

  // RTC 信令
  rtcCreateMeeting: 'server:rtc:createMeeting',
  rtcGetMeeting: 'server:rtc:getMeeting',
  rtcJoin: 'server:rtc:join',
  rtcSignal: 'server:rtc:signal',
  rtcLeave: 'server:rtc:leave',
  rtcEnd: 'server:rtc:end',
  rtcDmCall: 'server:rtc:dmCall',
  rtcDmAnswer: 'server:rtc:dmAnswer',
  rtcGroupCall: 'server:rtc:groupCall',
  /** 会议内聊天消息发送 */
  rtcChatSend: 'server:rtc:chatSend',

  // 个人信息
  userUpdateProfile: 'server:user:updateProfile',
  /** 修改密码（旧密码 + 新密码） */
  userChangePassword: 'server:user:changePassword',
  /** 主邮件配置：读取（含当前用户是否 SERVER_ADMIN、来源 env/db、是否可改） */
  serverGetMainMail: 'server:mail:getMain',
  /** 主邮件配置：设置（需 SERVER_ADMIN，仅环境未配置时生效） */
  serverSetMainMail: 'server:mail:setMain',
  /** 下载远程文件到本地缓存目录，返回本地路径（图片/视频/3D 预览用） */
  serverDownloadFile: 'server:downloadFile',
  /** 读取本地文件为 ArrayBuffer（3D 模型解析用） */
  serverReadFileBytes: 'server:readFileBytes',

  // 窗口
  winMinimize: 'win:minimize',
  winToggleMaximize: 'win:toggleMaximize',
  winClose: 'win:close',
  /** 登录成功→切换为主窗口模式（可缩放、恢复尺寸） */
  winSetMainMode: 'win:setMainMode',
  /** 回到登录页→恢复登录窗口模式（固定 480x638、不可缩放） */
  winSetLoginMode: 'win:setLoginMode',
  /** 打开独立会议窗口 */
  openMeetingWindow: 'win:openMeeting',
  /** 打开独立任务详情窗口 */
  openTaskWindow: 'win:openTask',
  /** 打开独立 Office 预览窗口（PDF / Word / Excel），入参 { kind, path, name } */
  openPreviewWindow: 'win:openPreview',
  /** 打开独立远程控制窗口（控制端），入参 { room, iceServers, mode, peerId, peerName } */
  openRemoteWindow: 'win:openRemote',
  /** 远程窗口 ready 后取待处理会话参数 */
  remoteGetParams: 'remote:getParams',
  /** 打开独立全屏截屏窗口（固定不可调整），入参 { dataUrl, width, height } */
  openScreenshotWindow: 'win:openScreenshot',
  /** 截屏窗口 ready 后取待处理截图数据 */
  screenshotGetPending: 'shot:getPending',
  /** 截屏窗口保存：主进程写临时 PNG、关窗、并通知主窗口发送 */
  screenshotSave: 'shot:save',
  /** 截屏窗口按框选区域缩放定位（冻结画面跟随选框）：{ sel:{x,y,w,h}(物理像素), toolbarDIP } */
  screenshotResize: 'shot:resize',
  /** 独立工具栏窗口 → 主进程 → 截图窗口：驱动编辑命令 { action, value? } */
  screenshotToolbarCommand: 'shot:toolbarCommand',
  /** 截图窗口 → 主进程：显示/隐藏独立工具栏窗口（全屏编辑时隐藏，框选时显示） */
  screenshotToolbarVisible: 'shot:toolbarVisible',
  /** 截图窗口 → 主进程：移动独立工具栏窗口到目标位置（DIP） */
  screenshotToolbarPos: 'shot:toolbarPos',
  /** 截图窗口 → 主进程 → 工具栏窗口：已进入编辑（框选完成），工具栏切换到完整工具/颜色/保存 */
  screenshotToolbarEdit: 'shot:toolbarEdit',
  /** 最小化/后台时弹 Windows 通知（点击唤起窗口） */
  notify: 'win:notify',
  /** 查询当前窗口聚焦/可见/最小化状态 */
  getWindowState: 'win:getWindowState',
  /** 唤起/置顶当前窗口 */
  focusWindow: 'win:focusWindow',
  /** 保存通话/会议录制（base64）到 {downloadDir}/通话录制/，返回 {ok,path,error} */
  appSaveRecording: 'app:saveRecording',
  appInfo: 'app:info',
  /** 读取品牌配置（软件名/图标，随安装包打包） */
  brandingGet: 'app:brandingGet',
  /** 在系统文件管理器中打开本地文件所在路径 */
  appOpenFileLocation: 'app:openFileLocation',
  /**
   * 用系统默认程序打开本地文件（shell.openPath）。
   * 聊天里不能内嵌预览的文件（txt/zip/exe/…）必须走这里：直接给渲染层一个
   * app-file:// 链接用 target=_blank 打开，Electron 只会弹「获取打开此"about"的应用」。
   * Windows/macOS/Linux 通用；没有关联程序时由系统自己弹「选择打开方式」，与双击文件一致。
   */
  appOpenPath: 'app:openPath',
  /** 写系统剪贴板（消息右键「复制」用）：走主进程 Electron clipboard，不依赖页面是否聚焦/安全上下文 */
  appClipboardWriteText: 'app:clipboardWriteText',
  /** 把本地图片文件写进系统剪贴板（右键图片消息「复制图片」） */
  appClipboardWriteImage: 'app:clipboardWriteImage',
  /** 把一段二进制写成临时文件并返回路径（粘贴剪贴板图片发送、主进程不碰渲染层 blob） */
  appWriteTempFile: 'app:writeTempFile',
  /** 解析通知提示音该播哪个文件：自定义存在用它，丢失/为空自动回退 resources 里的默认 */
  appResolveNotifySound: 'app:resolveNotifySound',
  // 远程控制输入注入（被控端 main）：start 设键鼠模式，event 分发控制指令，stop 复位+结束
  remoteInputStart: 'remote:input:start',
  remoteInputStop: 'remote:input:stop',
  remoteInputEvent: 'remote:input:event'
} as const

/** 通知管理器：目标窗口 + 参数（点击通知按此打开窗口） */
export type NotifTarget =
  | { kind: 'main'; nav?: string; conversationId?: number }
  | { kind: 'meeting'; mode: 'create' | 'join'; callType?: 'voice' | 'video'; meetingNo?: string; password?: string }

/**
 * 通知类型：通知管理器按类型区分处理（提示音、托盘闪动、紧急程度、免打扰策略）。
 *   - message  普通会话消息（受全局/会话免打扰影响）
 *   - call     单人语音/视频来电（来电优先级最高，不受免打扰静音）
 *   - meeting  会议 / 群通话邀请（同上）
 *   - task     任务提醒
 *   - alarm    闹钟：闹钟自己会播放铃声（见 utils/alarms.ts），不走通知管理器
 *   - system   其他系统级提示（新设备登录、远程控制请求等）
 */
export type NotifKind = 'message' | 'call' | 'meeting' | 'task' | 'alarm' | 'system'

/** 通知管理器入参（渲染层 → 主进程） */
export interface NotifyPayload {
  kind?: NotifKind
  title: string
  body: string
  target?: NotifTarget
  tray?: boolean
  /** 免打扰判定已在渲染层完成；这里只描述「显示行为」 */
  force?: boolean
}

/** 各种通知类型的中文名（日志与调试用） */
export const NOTIF_KIND_LABEL: Record<NotifKind, string> = {
  message: '消息',
  call: '电话',
  meeting: '会议',
  task: '任务',
  alarm: '闹钟',
  system: '系统'
}

/** 主进程 → 渲染进程推送事件 */
export const IpcEvents = {
  serverState: 'server:event:state',
  serverMessage: 'server:event:message',
  navigateToConversation: 'app:navigateToConversation',
  serverPresence: 'server:event:presence',
  serverMessageDeleted: 'server:event:messageDeleted',
  serverConversationsUpdated: 'server:event:conversationsUpdated',
  serverChatReadReceipt: 'server:event:chatReadReceipt',
  /** 新设备登录 → 本端弹窗提醒 */
  serverSessionNewDevice: 'server:event:sessionNewDevice',
  /** 会话被踢下线/过期 → 本端清 token 回登录页 */
  serverSessionRevoked: 'server:event:sessionRevoked',
  /**
   * 断线后连续重试仍失败 → 回登录页（保留 token，方便直接重登/下次启动自动登录）。
   * 与 sessionRevoked 的区别：那个是会话真的失效要清 token，这个只是连不上服务器。
   */
  serverReconnectGaveUp: 'server:event:reconnectGaveUp',
  /** RTC：单人来电 / 拒接 / 对端加入离开 / SDP+ICE / 通话结束 / 群呼 */
  rtcDmIncoming: 'server:event:rtc:dmIncoming',
  rtcDmRejected: 'server:event:rtc:dmRejected',
  rtcPeerJoined: 'server:event:rtc:peerJoined',
  rtcPeerLeft: 'server:event:rtc:peerLeft',
  rtcSignal: 'server:event:rtc:signal',
  rtcEnded: 'server:event:rtc:ended',
  rtcGroupCall: 'server:event:rtc:groupCall',
  /** 会议内聊天消息推送 */
  rtcChatMessage: 'server:event:rtc:chatMessage',
  /** 群成员变更（禁言/加人/踢人/设管理员）→ 各端刷新群设置 */
  groupMembersUpdated: 'server:event:group:membersUpdated',
  /** 收到群邀请 */
  groupInvite: 'server:event:group:invite',
  groupDissolved: 'server:event:group:dissolved',
  companyDissolved: 'server:event:company:dissolved',
  companyUpdated: 'server:event:company:updated',
  companyRemoved: 'server:event:company:removed',
  companyAdded: 'server:event:company:added',
  groupAdded: 'server:event:group:added',
  groupRemoved: 'server:event:group:removed',
  friendsUpdated: 'server:event:friends:updated',
  holidaysUpdated: 'server:event:holidays:updated',
  tasksUpdated: 'server:event:tasks:updated',
  projectsUpdated: 'server:event:projects:updated',
  requirementsUpdated: 'server:event:requirements:updated',
  /** 日报/周报：服务端到点提醒（{ companyId, type, periodDate, missingUsers }）→ 渲染层刷新统计并顶部提示 */
  reportReminder: 'server:event:report:reminder',
  bugsUpdated: 'server:event:bugs:updated',
  plansUpdated: 'server:event:plans:updated',
  docsUpdated: 'server:event:docs:updated',
  wikiUpdated: 'server:event:wiki:updated',
  userProfileUpdated: 'server:event:user:profileUpdated',
  /** 分块上传进度：{ uploadId, fileName, percent, done? } */
  uploadProgress: 'server:event:uploadProgress',
  /** 下载到本地的进度：{ url, received, total, percent }（total=0 表示未知，做不确定进度） */
  downloadProgress: 'server:event:downloadProgress',
  /** 托盘"设置"入口，通知 renderer 打开设置面板 */
  uiOpenSettings: 'ui:event:openSettings',
  /** 截屏窗口保存成功 → 通知主窗口把临时 PNG 发送到当前会话 */
  screenshotSaved: 'shot:event:saved',
  /** 独立工具栏窗口 → 截图窗口：编辑命令 { action, value? } */
  screenshotToolbarCommand: 'shot:event:toolbarCommand',
  /** 截图窗口 → 工具栏窗口：已进入编辑，切换完整工具栏 */
  screenshotToolbarEdit: 'shot:event:toolbarEdit',
  /** 远程设备控制：服务端 → 被控端（客户端 app）事件 */
  devView: 'dev:event:view',
  devEnumerate: 'dev:event:enumerate',
  devStart: 'dev:event:start',
  devStop: 'dev:event:stop',
  devSignal: 'dev:event:signal'
} as const

/** 独立截屏工具栏窗口固定尺寸（DIP）——高度贴近内容(按钮~23px+上下padding)，消除上下空余 */
export const ScreenshotToolbar = { WIDTH: 980, HEIGHT: 40 } as const
