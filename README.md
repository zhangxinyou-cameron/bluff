# BLUFF · THE RIVER

供朋友联机娱乐的私人德州扑克服务器。Node.js 统一管理规则、账户和回合，手机与电脑通过网页参与，支持 2—8 名真人／人机。

## 启动

当前主要在 Windows + Node.js 22 + Chrome 验证。

```powershell
git clone https://gitee.com/zhang-xinyou/bluff.git
cd bluff
npm ci --omit=dev
npm start
```

也可双击 `start.bat`；本机需在 PATH 中安装 Node.js，或在项目目录放置便携版 `node.exe`。每次启动都设置本次网站访问密码，之后打开终端显示的本地地址。网页、静态资源和 WebSocket 均需验证密码。

公网访问使用 Cloudflare Tunnel：Windows 将官方 `cloudflared.exe` 放在项目根目录，启动时会自动创建临时公网地址。缺少该工具时仍可本地运行。将终端提供的 HTTPS 地址、房间号和本次密码告知朋友。临时地址会变化；服务器重启不保留内存中的房间。

仓库不包含 Node.js、Cloudflare 可执行文件、`node_modules`、运行数据和旧打包文件。现有便携目录中的这些本地文件可以继续使用。

## 玩法与界面

- 标准／短牌切换、全员底注／标准大小盲／自定义盲注、主池与边池、全押发两次协商。
- 买入与虚拟银行贷款、还款、净筹码排名，所有在线玩家确认后再开始下一手。
- 服务器根据公开信息估算人机胜率，结合底池赔率、位置、价值下注、持续下注和诈唬策略决策。
- 所有客户端共享固定的顺时针座位；头像可选，支持断线恢复、暂离及踢出后的手动重进。
- 定向看牌采用 10 秒确认弹窗；聊天、快捷语言包、番茄／鲜花等动画互动；半池到双池的加注快捷项。
- 手机／电脑布局，中央回合提示、操作倒计时、完整行动记录，以及 Python 合成的柔和音效和三首慢爵士。

详细操作、底注规则、音频包扩展方式见 [使用说明](使用说明.txt)。

## 开发与测试

```powershell
npm ci
npm test
npm run test:experience
npm run test:table
npm run test:ui
npm run test:ai
```

浏览器回归使用 Playwright 和本机 Chrome，主要脚本默认 Chrome 位于 `C:/Program Files/Google/Chrome/Application/chrome.exe`；其他安装位置请调整脚本中的 `executablePath`。测试在随机本地端口使用独立临时密码，不启动生产公网隧道。

当前验证说明见 [tests/验证报告.md](tests/验证报告.md)。截图及 JSON 测试输出会在本机生成，默认不提交。实体手机及实际运营商公网不在本轮自动回归范围内。

## 代码位置

| 路径 | 职责 |
| --- | --- |
| `server.js` / `access.js` | HTTP、WebSocket、访问验证与启动 |
| `room-manager.js` / `room-extras.js` | 房间、账户、重连、交互与服务器计时 |
| `poker-ai.js` | 公开信息概率估计和人机下注 |
| `public/poker-engine.js` | 牌型、下注、盲注与分池规则 |
| `public/` | 网页、布局、客户端同步、头像与声音素材 |
| `tests/` | 自动规则测试和多客户端浏览器回归 |
| `tools/synthesize_audio.py` | 原创音效／音乐合成，重新生成需 Python 3 和 NumPy |

音频素材已随源码提供，正常开服无需 Python。
