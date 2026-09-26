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

  // 账号
  serverRegister: 'server:register',
  serverLogin: 'server:login',
  /** 发送邮箱验证码（注册验证 / 验证码登录） */
  serverSendEmailCode: 'server:sendEmailCode',
  serverSendResetCode: 'server:sendResetCode',
  serverSendResetMail: 'server:sendResetMail',
  serverLogout: 'server:logout',
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

  // 文件上传
  serverUpload: 'server:upload',
  /** 分块上传（带进度回调，支持断点续传；完成后返回 {ok,url,...}） */
  serverUploadChunked: 'server:uploadChunked',
  /** 打开系统文件选择框，返回所选文件路径（用于发送图片/文件） */
  filePick: 'file:pick',
  /** 打开系统文件夹选择框，返回所选目录路径（用于发送文件夹） */
  filePickFolder: 'file:pickFolder',
  /** 递归枚举文件夹内所有文件路径 */
  serverListFolderFiles: 'server:listFolderFiles',
  /** 下载整个文件夹到配置路径（按原结构建目录）：{relPath} */
  serverDownloadFolder: 'server:downloadFolder',
  /** 捕获主屏幕存为临时 PNG，返回临时文件路径（用于发送截屏） */
  fileCaptureScreen: 'file:captureScreen',

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
  /** 最小化/后台时弹 Windows 通知（点击唤起窗口） */
  notify: 'win:notify',
  /** 查询当前窗口聚焦/可见/最小化状态 */
  getWindowState: 'win:getWindowState',
  /** 唤起/置顶当前窗口 */
  focusWindow: 'win:focusWindow',
  /** 保存通话/会议录制（base64）到 {downloadDir}/通话录制/，返回 {ok,path,error} */
  appSaveRecording: 'app:saveRecording',
  appInfo: 'app:info',
  /** 在系统文件管理器中打开本地文件所在路径 */
  appOpenFileLocation: 'app:openFileLocation'
} as const

/** 主进程 → 渲染进程推送事件 */
export const IpcEvents = {
  serverState: 'server:event:state',
  serverMessage: 'server:event:message',
  serverPresence: 'server:event:presence',
  serverMessageDeleted: 'server:event:messageDeleted',
  serverConversationsUpdated: 'server:event:conversationsUpdated',
  /** 新设备登录 → 本端弹窗提醒 */
  serverSessionNewDevice: 'server:event:sessionNewDevice',
  /** 会话被踢下线/过期 → 本端清 token 回登录页 */
  serverSessionRevoked: 'server:event:sessionRevoked',
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
  userProfileUpdated: 'server:event:user:profileUpdated',
  /** 分块上传进度：{ uploadId, fileName, percent, done? } */
  uploadProgress: 'server:event:uploadProgress',
  /** 托盘"设置"入口，通知 renderer 打开设置面板 */
  uiOpenSettings: 'ui:event:openSettings'
} as const
