// ========== 常量 ==========
const SUITS = ['♠','♥','♣','♦'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const HAND_NAMES = {10:'皇家同花顺',9:'同花顺',8:'四条',7:'葫芦',6:'同花',5:'顺子',4:'三条',3:'两对',2:'一对',1:'高牌'};
const PHASE_NAMES = {waiting:'等待',pre_flop:'翻牌前',flop:'翻牌',turn:'转牌',river:'河牌',runout_vote:'梭哈协商',showdown:'摊牌',hand_over:'结束'};
const QUICK_CHATS = ['拿到大牌了，快跑！','这牌我梭了！','跟注，看看你的牌','哇，又是皇家同花顺？','不送了，弃','river太骚了','下把我必赢','你这牌也敢跟？'];

// ========== 联机状态 ==========
let ws = null;
let wsConnected = false;
let connectionTimer = null;
let isHost = false;
let lobbyLeague = null;
let waitingRoom = null;
let mySeatId = -1;
let roomCode = '';
let myName = '玩家' + Math.floor(Math.random()*100);
let seats = [];        // 座位列表 [{id, name, isHost, ready}]
var g = null;         // 服务器提供给房主的安全快照；访客使用 clientGameState
let clientGameState = null; // client收到的游戏状态
let chatMessages = [];
let maxPlayers = 8;
let aiSlots = {};
let settings = { bigBlind: 20, initChips: 2000, minPlayers: 2, allowBuyIn:false, showWinRate:true };
let raiseMode = false, raiseValue = 0;
let actionPending = false;
let aiTimer = null;
let bankPending = false;
let bankRequestSequence = 0;
let bankNotice = '';

// ========== 牌型庄擎 ==========
const { evalBest } = PokerEngine;

// ========== 牌型与界面辅助计算（游戏状态由服务器托管） ==========

// 蒙特卡洛胜率
const winRateCache = new Map();
let oddsWorker, oddsRunning, oddsQueued, oddsDisplayKey, oddsFailed = false;
function queueWinRate() {
  if (!oddsRunning && oddsQueued) {
    oddsRunning = oddsQueued;
    oddsQueued = null;
    oddsWorker.postMessage(oddsRunning);
  }
}
const winRateLabel = (value, preflop) => value == null ? (oddsFailed ? '胜率暂不可用' : '胜率计算中…') :
  preflop ? `估计胜率 ${value}%` : `胜率: ${value}%`;
function calcWinRate(myCards, commCards, numOpp, variant='standard') {
  if (numOpp <= 0) return 100;
  const key = variant+'/'+myCards.map(c=>c.id).sort((a,b)=>a-b).join(',') + '/' + commCards.map(c=>c.id).join(',') + '/' + numOpp;
  oddsDisplayKey = key;
  if (winRateCache.has(key)) return winRateCache.get(key);
  if (oddsFailed) return null;
  if (!oddsWorker) {
    const fail = () => {
      oddsFailed = true;
      oddsWorker?.terminate();
      if (oddsDisplayKey) document.getElementById('winRateText').textContent = winRateLabel(null);
    };
    try {
      oddsWorker = new Worker('/odds-worker.js');
      oddsWorker.onerror = fail;
      oddsWorker.onmessage = ({ data }) => {
        if (winRateCache.size >= 64) winRateCache.delete(winRateCache.keys().next().value);
        winRateCache.set(data.key, data.value);
        if (data.key === oddsDisplayKey) document.getElementById('winRateText').textContent = winRateLabel(data.value, !oddsRunning.board.length);
        oddsRunning = null;
        queueWinRate();
      };
    } catch {
      fail();
      return null;
    }
  }
  if (oddsRunning?.key !== key) oddsQueued = { key, hole: myCards, board: commCards, opponents: numOpp, variant };
  queueWinRate();
  return null;
}

function startNewHand() { raiseMode = false; return PokerEngine.startHand(g); }

// ========== 联机同步 ==========
function broadcast(msg) {
  // 房主通过WebSocket发送给服务器，服务器中继
  if (isHost && wsConnected) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastSeats() {
  broadcastSeatsAll();
  renderSeats();
}

function startGameHost() {
  if (g) return;
  g = { players: [] };
  // 真人玩家
  seats.forEach((s, i) => {
    if (!s) return;
    g.players.push({ id: i, name: s.name, chips: settings.initChips, holeCards: [], currentBet: 0, totalBet: 0, folded: false, allIn: false, isActive: true, isAI: !!s.isAI, handResult: null, chipsBeforeHand: settings.initChips, peerId: s.id });
  });
  // 人机玩家
  const aiNames = ['Alpha','Beta','Gamma','Delta','Omega','Sigma'];
  let aiIdx = 0;
  for (let i = 0; i < maxPlayers; i++) {
    if (!seats[i] && aiSlots[i]) {
      g.players.push({ id: i, name: aiNames[aiIdx%aiNames.length], chips: settings.initChips, holeCards: [], currentBet: 0, totalBet: 0, folded: false, allIn: false, isActive: true, isAI: true, handResult: null, chipsBeforeHand: settings.initChips, peerId: 'ai-'+i });
      aiIdx++;
    }
  }
  if (g.players.length < 2) { g = null; return; }
  g = PokerEngine.createGame(g.players, settings.bigBlind, {allowBuyIn:settings.allowBuyIn,hostSeatId:mySeatId});
  startNewHand();
  broadcastGameState('gameStart');
  showGameScreen();
  renderGame(g);
  // 让AI行动
  scheduleAI();
}

function serializeGame(g, viewerId) {
  if (viewerId === undefined) viewerId = mySeatId;
  const showAllCards = (g.phase === 'hand_over' || g.phase === 'showdown');
  return {
    handNumber: g.handNumber,
    phase: g.phase,
    showdownOccurred:g.showdownOccurred===true,
    pot: g.pot,
    currentBet: g.currentBet,
    dealerIndex: g.dealerIndex,
    currentPlayerIndex: g.currentPlayerIndex,
    communityCards: g.communityCards,
    minRaise: g.minRaise,
    bigBlind: g.bigBlind,
    revision: g.revision,
    nextHandReady: g.nextHandReady,
    winners: g.winners,
    pots: g.pots,
    allowBuyIn: g.allowBuyIn,
    showWinRate:g.showWinRate!==false,
    endRequested: g.endRequested,
    bankLog: g.bankLog,
    bankSequence: g.bankSequence,
    players: g.players.map(p => ({
      id: p.id, name: p.name, chips: p.chips, currentBet: p.currentBet,
      folded: p.folded, allIn: p.allIn, isActive: p.isActive,
      handResult: p.handResult, acted: p.acted,
      canRaise: PokerEngine.canRaise(g, p),
      disconnected: !!p.disconnected,
      isAI: !!p.isAI,
      chipsBeforeHand: p.chipsBeforeHand,
      chipsAfterHand: p.chipsAfterHand,
      initialChips:p.initialChips,bankDebt:p.bankDebt,totalBorrowed:p.totalBorrowed,totalRepaid:p.totalRepaid,bankVersion:p.bankVersion,
      eliminatedHand: p.eliminatedHand,
      eliminationStack: p.eliminationStack,
      showFolded: p.showFolded || false,
      // Only an actual showdown or the owner's explicit choice reveals cards.
      holeCards: (showAllCards && ((g.showdownOccurred===true&&!p.folded)||p.showFolded)) ? p.holeCards : (p.id === viewerId ? p.holeCards : [])
    }))
  };
}

// 给每个玩家单独发（只发他自己的底牌）
function broadcastGameState(msgType) {
  msgType = msgType || 'state';
  // 房主发送给服务器，服务器中继给所有房客
  // 每个房客需要不同的底牌，用p.id作为targetSeat和viewerId
  if (!isHost || !wsConnected) return;
  g.players.forEach((p) => {
    if (p.id === mySeatId || p.isAI) return; // 跳过房主和人机
    ws.send(JSON.stringify({ type: msgType, targetSeat: p.id, game: serializeGame(g, p.id) }));
  });
}

// ========== UI渲染 ==========
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function rankClass(rank) { if (rank>=13) return 'rank-high'; if (rank>=10) return 'rank-mid'; return 'rank-low'; }
function fmtCard(c) {
  return `<div class="card suit-${c.suit} ${rankClass(c.rank)}"><span class="card-suit">${SUITS[c.suit]}</span><span class="card-rank">${RANKS[c.rank-2]}</span></div>`;
}
function fmtCardSmall(c) {
  return `<div class="card small suit-${c.suit} ${rankClass(c.rank)}"><span class="card-suit">${SUITS[c.suit]}</span><span class="card-rank">${RANKS[c.rank-2]}</span></div>`;
}

function renderSeats() {
  const deck={auto:'自动牌制（4 人及以下短牌）',short:'36 张短牌',standard:'52 张标准牌'}[settings.deckMode||'auto'];
  const blinds={auto:'底注随牌制',ante:'全员底注＋庄家盲注',position:'下家 1 倍／再下家半倍',standard:'大小盲半倍／1 倍'}[settings.blindMode||'auto'];
  const buyIn=settings.allowBuyIn?`允许贷款买入 · ${settings.buyInThreshold==null?'筹码门槛不限':`筹码低于 ${settings.buyInThreshold} 可买入`} · 每手上限 ${settings.loanPerHandLimit??'无限'} · 未还本金上限 ${settings.loanTotalLimit??'无限'}`:
    `淘汰赛 · 结算人数门槛 ${settings.minPlayers} 人`;
  document.getElementById('waitRuleSummary').textContent=
    `${deck} · ${blinds} · 1 倍底注 ${settings.bigBlind} · 初始筹码 ${settings.initChips} · ${buyIn} · ${settings.showWinRate===false?'不显示胜率':'显示胜率'} · 跑马间隔 ${(settings.runoutDelayMs??3000)/1000} 秒`;
  let html = '';
  for (let i = 0; i < maxPlayers; i++) {
    const s = seats[i];
    if (s) {
      html += `<div class="seat ${s.ready?'ready':''}">
        <div class="seat-avatar">${typeof RiverAvatars!=='undefined'?RiverAvatars.markup(s.avatar,s.name):s.isAI?'🤖':'♠'}</div>
        <div class="seat-name">${escapeHtml(s.name)}</div>
        <div class="seat-status">${s.isHost?'房主':''} ${s.isAI?'人机':''} ${s.connected===false?'暂离 · 席位保留':s.ready?'✅已准备':'⏳未准备'}</div>
      </div>`;
    } else {
      const isAI = aiSlots[i];
      if (isHost) {
        html += `<div class="seat" role="button" tabindex="0" aria-label="${isAI?'移除人机':'添加人机'}" onclick="toggleAI(${i})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click();}">
          <div class="seat-avatar">${isAI?'🤖':'➕'}</div>
          <div class="seat-name">${isAI?'人机':'空位'}</div>
          <div class="seat-status">${isAI?'点击移除':'点击设为人机'}</div>
        </div>`;
      } else {
        html += `<div class="seat" style="opacity:0.4">
          <div class="seat-avatar">${isAI?'🤖':'➕'}</div>
          <div class="seat-name">${isAI?'人机':'空位'}</div>
          <div class="seat-status">${isAI?'等待开始':'等待加入'}</div>
        </div>`;
      }
    }
  }
  document.getElementById('seats').innerHTML = html;
  const humanSeats = seats.filter(s => s && !s.isAI && s.connected!==false);
  const allHumanReady = humanSeats.every(s => s.ready || s.isHost);
  if (isHost) {
    const totalPlayers = seats.filter(s=>s&&s.connected!==false).length + Object.keys(aiSlots).filter(k=>aiSlots[k] && !seats[k]).length;
    const canStart = wsConnected && (waitingRoom?.canStart ?? (allHumanReady && totalPlayers >= 2));
    const start = document.getElementById('startBtn');
    start.style.display = waitingRoom || canStart ? 'block' : 'none';
    start.disabled = !canStart;
  }
  if(waitingRoom){
    const text=waitingRoom.canStart?'全员已准备，房主可以开始':waitingRoom.blockers.join(' · ');
    const rules=waitingRoom.rulesRevision&&waitingRoom.awaiting.length?' · 规则已更新，请确认后准备':'';
    document.getElementById('leagueReadyState').textContent=`${waitingRoom.ready}/${waitingRoom.players} 已准备 · ${text}${rules}`;
  }
  const readyBtn = document.getElementById('readyBtn');
  const seat = seats[mySeatId];
  readyBtn.disabled = !wsConnected || !seat || !!seat.ready;
  readyBtn.textContent = seat && seat.ready ? '✅ 已准备' : '准备';
}

function toggleAI(idx) {
  if (!isHost) return;
  aiSlots[idx] = !aiSlots[idx];
  broadcastSettings();
  renderSeats();
}

function showGameScreen() {
  document.getElementById('homeScreen').style.display = 'none';
  document.getElementById('waitScreen').style.display = 'none';
  document.getElementById('gameScreen').style.display = 'flex';
  document.getElementById('resultScreen').style.display = 'none';
  renderChat();
}

function tableSeatRows(players) {
  // A single clockwise ring for every viewer: top L→R, then bottom R→L.
  const split=Math.ceil(players.length/2);
  return [players.slice(0,split),players.slice(split).reverse()];
}

function potRaisePresets(game,player) {
  const call=Math.max(0,game.currentBet-player.currentBet),potAfterCall=game.pot+Math.min(call,player.chips);
  const min=game.currentBet+game.minRaise,max=player.currentBet+player.chips;
  return [[.5,'半池'],[.75,'¾池'],[1,'满池'],[2,'双倍底池']].map(([fraction,label])=>({fraction,label,amount:Math.min(max,Math.max(min,Math.round(game.currentBet+potAfterCall*fraction)))}));
}

function compactAction(record) {
  const names={fold:'弃牌',check:'过牌',call:'跟注',raise:'加注至',allin:'梭哈至'};
  const amount=record.displayAmount??Number(record.label?.match(/ (\d+)$/)?.[1]);
  if(['call','raise','allin'].includes(record.action)&&Number.isSafeInteger(amount)&&amount>=0) return {name:names[record.action],amount};
  return {name:names[record.action]??record.label,amount:null};
}

function raiseSliderSpec(game,player) {
  const step=Math.max(1,Math.floor(game.smallBlind??game.bigBlind/2));
  const min=Math.ceil((game.currentBet+game.minRaise)/step)*step;
  const max=Math.floor((player.chips+player.currentBet)/step)*step;
  return {step,min,max,disabled:min>max};
}

function renderGame(g) {
  updateSessionTools(g);
  const myPosition=g.players.find(p=>p.id===mySeatId)?.position;
  document.getElementById('handNum').textContent = `第${g.handNumber}局${myPosition?' · '+myPosition.label:''}`;
  document.getElementById('phaseText').textContent = PHASE_NAMES[g.phase]||'';
  document.getElementById('potText').textContent = `底池: ${g.pot}`;
  document.getElementById('potDisplay').textContent = `底池 ${g.pot}`;

  let ccHtml = '';
  g.communityCards.forEach(c => ccHtml += fmtCard(c));
  for (let i=0; i<5-g.communityCards.length; i++) ccHtml += `<div class="card card-empty"></div>`;
  document.getElementById('communityCards').innerHTML = ccHtml;
  if(g.runoutBoards)document.getElementById('communityCards').innerHTML=g.runoutBoards.map((board,i)=>`<div class="runout-board" data-board="${i}"><small>第 ${i+1} 组</small>${board.map(fmtCard).join('')}${Array.from({length:5-board.length},()=>'<div class="card card-empty"></div>').join('')}</div>`).join('');

  const seatHtml=new Map();
  g.players.forEach((p, idx) => {
    if(!(p.isActive||p.position||g.positions?.[p.id]||p.connected!==false&&!p.disconnected&&!p.waitingForHand))return;
    let cardsHtml='';
    // The server filters all private cards, including consent-based reveals.
    if(p.holeCards?.length===2)p.holeCards.forEach(c=>cardsHtml+=fmtCard(c));
    else if(!p.folded)cardsHtml='<div class="card card-back"></div><div class="card card-back"></div>';
    const cls = `player-card ${p.id===mySeatId?'is-self':''} ${p.folded?'folded':''} ${g.currentPlayerIndex===idx?'active':''} ${p.allIn?'allin':''}`;
    if(g.dealing&&p.isActive)cardsHtml='<div class="card card-back"></div><div class="card card-back"></div>';
    if(!p.isActive)cardsHtml=`<span class="sitting-out">${p.disconnected?'已退桌':p.chips>0?'本手旁观 · 下手加入':g.allowBuyIn?'待买入 · 观战':'已出局'}</span>`;
    let html = `<div class="${cls}" data-seat="${p.id}" role="button" tabindex="0" aria-label="与${escapeHtml(p.name)}互动" onclick="RiverTable.open(${p.id})" onkeydown="if(event.key==='Enter')RiverTable.open(${p.id})">`;
    if (idx === g.dealerIndex) html += `<div class="dealer-btn">庄</div>`;
    if(p.id===mySeatId)html+='<span class="self-seat-label">你</span>';
    const position=p.position;
    html += `<div class="player-name">${typeof RiverAvatars!=='undefined'?RiverAvatars.markup(p.avatar,p.name):`<span class="player-avatar" data-avatar="default">${p.isAI?'🤖':'♠'}</span>`}<span class="player-label" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span></div><div class="player-chips">${position?`<span class="player-position" title="${escapeHtml(position.description)} · 翻前第${position.preflop}位 / 翻后第${position.postflop}位">${escapeHtml(position.label)}</span>`:''}<span>💰${p.chips}</span></div>`;
    const currentAction=p.lastAction?.hand===g.handNumber&&p.lastAction.phase===g.phase?p.lastAction:null;
    const summary=currentAction&&compactAction(currentAction);
    const actionText=summary?.name||(p.folded?'已弃牌':p.allIn?'已梭哈':!p.isActive?'本手旁观':'尚未行动');
    const offline=p.connected===false?' · 暂离':'';
    const hasAmount=summary?.amount!=null;
    const actionContent=hasAmount?`<span class="player-action-name">${escapeHtml(actionText+offline)}</span> <strong class="player-action-amount">${summary.amount}</strong>`:escapeHtml(actionText+offline);
    html += `<div class="player-action move-${escapeHtml(currentAction?.action||'waiting')}${hasAmount?' has-amount':''}" title="${escapeHtml((currentAction?.label||actionText)+offline)}">${actionContent}</div>`;
    if (p.currentBet>0) html += `<div class="player-bet">贡献:${p.currentBet}</div>`;
    html += `<div class="hole-cards">${cardsHtml}</div>${p.privateReveal&&p.id!==mySeatId?'<span class="private-card-note">仅向你亮牌</span>':''}</div>`;
    seatHtml.set(p.id,html);
  });
  const rows=tableSeatRows(g.players.filter(p=>seatHtml.has(p.id)));
  document.getElementById('playersTop').innerHTML = rows[0].map(p=>seatHtml.get(p.id)).join('');
  document.getElementById('playersBottom').innerHTML = rows[1].map(p=>seatHtml.get(p.id)).join('');

  // 牌型+胜率提示
  const infoBar = document.getElementById('handInfoBar');
  const showWinRate=g.showWinRate!==false;
  oddsDisplayKey=null;
  oddsQueued=null;
  document.getElementById('winRateText').hidden=!showWinRate;
  const cp0 = g.players.find(p=>p.id===mySeatId);
  if (cp0 && !cp0.folded && cp0.holeCards && cp0.holeCards.length > 0 && g.phase !== 'hand_over') {
    let hType = '', wRate = '';
    if (g.communityCards.length >= 3) {
      const hr = evalBest([...cp0.holeCards, ...g.communityCards],g.variant);
      if (hr) hType = `当前: ${hr.name}`;
      const opps = g.players.filter(p => p.isActive && !p.folded).length - 1;
      if (showWinRate&&opps > 0) wRate = winRateLabel(calcWinRate(cp0.holeCards, g.communityCards, opps,g.variant), false);
    } else {
      hType = showWinRate?'起手牌评估中...':'翻牌前';
      const opps = g.players.filter(p => p.isActive && !p.folded).length - 1;
      if(showWinRate)wRate = opps>0?winRateLabel(calcWinRate(cp0.holeCards,[],opps,g.variant), true):'胜率 100%';
    }
    infoBar.style.display = 'flex';
    document.getElementById('handTypeText').textContent = hType;
    document.getElementById('winRateText').textContent = wRate;
  } else {
    infoBar.style.display = 'flex';document.getElementById('handTypeText').textContent=cp0?.waitingForHand?'本手观战 · 下一手入座':cp0?.folded&&cp0.holeCards.length===2?'本手已弃牌 · 可申请看牌':cp0&&!cp0.isActive&&cp0.chips===0?'无筹码观战 · 可申请看牌':cp0?.chips>0?'本手旁观 · 下一手可加入':'等待下一手';document.getElementById('winRateText').textContent='';
  }

  // 操作按钮
  const cp = g.players.find(p=>p.id===mySeatId);
  const panel = document.getElementById('actionPanel');
  if (!wsConnected) {
    panel.innerHTML = '';
    document.getElementById('actionHint').textContent = '连接已断开，请重新加入房间';
    return;
  }
  if (!PokerEngine.betting(g) || !cp || !cp.isActive || cp.folded || cp.allIn || g.players[g.currentPlayerIndex]?.id !== mySeatId) {
    panel.innerHTML = '';
    document.getElementById('actionHint').textContent = !PokerEngine.betting(g) ? '' : `轮到 ${g.players[g.currentPlayerIndex]?.name || '其他玩家'} 行动`;
    return;
  }
  const need = g.currentBet - cp.currentBet;
  const canCheck = need === 0;
  if (actionPending) {
    panel.innerHTML = '';
    document.getElementById('actionHint').textContent = '操作已发送，等待房主确认...';
    return;
  }
  const raiseAllowed = cp.canRaise;
  const canRaise = raiseAllowed && cp.chips + cp.currentBet >= g.currentBet + g.minRaise;
  if(raiseMode&&!canRaise)raiseMode=false;

  if (raiseMode) {
    // 加注滑杆
    const minT = g.currentBet + g.minRaise;
    const maxT = cp.chips + cp.currentBet;
    if (raiseValue < minT) raiseValue = minT;
    if (raiseValue > maxT) raiseValue = maxT;
    const presets=potRaisePresets(g,cp);
    const slider=raiseSliderSpec(g,cp);
    let html = `<div class="raise-slider"><div class="raise-level">当前 ${g.betLevel||0}-BET · 本次加注为 ${(g.betLevel||0)+1}-BET · 滑条每格 ${slider.step}（小盲）</div><div class="raise-presets">${presets.map(({fraction,label,amount})=>`<button class="sound-button" data-pot-fraction="${fraction}" title="先跟注后，按底池 ${Math.round(fraction*100)}% 加注；受最小加注和筹码限制" onclick="RiverTable.raiseTo(${amount})"><span>${label}</span><small>至 ${amount}</small></button>`).join('')}${[3,4].map(multiple=>{const amount=Math.min(maxT,Math.max(minT,g.currentBet*multiple));return `<button class="sound-button" data-raise-multiple="${multiple}" onclick="RiverTable.raiseTo(${amount})"><span>${multiple}×当前注</span><small>至 ${amount}</small></button>`;}).join('')}</div><label class="raise-amount">加注至 <input id="raiseAmount" type="number" min="${minT}" max="${maxT}" value="${raiseValue}" inputmode="numeric" oninput="RiverTable.raiseInput(this.value)"><button class="sound-button" id="raiseMaxBtn" onclick="RiverTable.raiseTo(${maxT})" title="选择全部筹码，包括不足一格的零头">梭哈</button></label>
      <input type="range" min="${slider.disabled?minT:slider.min}" max="${slider.disabled?minT:slider.max}" step="${slider.step}" value="${raiseValue}" ${slider.disabled?'disabled':''} title="按小盲 ${slider.step} 的整数倍选择；精确数值可手输或点梭哈"
        oninput="raiseValue=parseInt(this.value);document.getElementById('raiseAmount').value=raiseValue;"/>
      <div style="display:flex;gap:8px;margin-top:6px;">
        <button class="action-btn action-cancel" onclick="cancelRaise()">取消</button>
        <button class="action-btn action-confirm" onclick="confirmRaise()">确认</button>
      </div></div>`;
    panel.innerHTML = html;
    return;
  }

  let html = `<div class="action-row"><button class="action-btn action-fold" onclick="playerAction('fold')">弃牌</button>`;
  if (canCheck) html += `<button class="action-btn action-check" onclick="playerAction('check')">过牌</button>`;
  else html += `<button class="action-btn action-call" onclick="playerAction('call')">跟注 ${Math.min(need,cp.chips)}</button>`;
  html += `</div><div class="action-row">`;
  if (canRaise) html += `<button class="action-btn action-raise" onclick="startRaise()">${(g.betLevel||0)+1}-BET · 加注至 ${g.currentBet+g.minRaise}</button>`;
  if (raiseAllowed || cp.chips+cp.currentBet<=g.currentBet) html += `<button class="action-btn action-allin" onclick="playerAction('allin')">梭哈 ${cp.chips}</button>`;
  html += '</div>';
  panel.innerHTML = html;
  document.getElementById('actionHint').textContent = `轮到你了`;
}

function showResultScreen(g) {
  updateSessionTools(g);
  document.getElementById('gameScreen').style.display = 'none';
  document.getElementById('resultScreen').style.display = 'flex';
  document.getElementById('winnerNames').innerHTML = g.pots.map((pot,index)=>{
    const label=index===0?'主池':g.pots.length===2?'边池':`边池 ${index}`;
    const awardName=award=>escapeHtml(g.players.find(p=>p.id===award.seatId)?.name||award.name||'玩家');
    const awards=pot.awards.map(award=>`${awardName(award)} ${pot.awards.length>1?'分得':'赢'}${label} <strong>${award.amount}</strong>`).join('、');
    const runs=pot.boards?pot.boards.map(run=>`<small>第 ${run.index+1} 组：${run.awards.map(a=>awardName(a)+' '+a.amount).join('、')}</small>`).join(''):'';
    return `<div class="pot-allocation">${awards}${runs}</div>`;
  }).join('');
  let ccHtml='';
  if(g.runoutBoards)ccHtml=g.runoutBoards.map((board,i)=>`<div class="board-result"><small>第 ${i+1} 组</small>${board.map(fmtCard).join('')}</div>`).join('');
  else g.communityCards.forEach(c=>ccHtml+=fmtCard(c));
  document.getElementById('resultCommunity').innerHTML=ccHtml;
  let prHtml='';
  g.players.filter(p=>p.isActive||p.connected!==false&&!p.disconnected&&!p.waitingForHand).forEach(p => {
    const net = (p.chipsAfterHand ?? p.chips) - (p.chipsBeforeHand ?? p.chips);
    prHtml += `<div class="player-result-row" data-result-seat="${p.id}"><span class="pr-name">${escapeHtml(p.name)}</span><div class="pr-cards">`;
    // The server sends private cards only to their owner or authorized viewers.
    if (p.holeCards && p.holeCards.length === 2) {
      p.holeCards.forEach(c=>prHtml+=fmtCardSmall(c));
    } else if (p.folded) {
      prHtml += `<span style="font-size:10px;color:#888;margin:0 4px;">弃牌</span>`;
    } else {
      prHtml += `<span class="unrevealed-hand" style="font-size:10px;color:#a6b69b;margin:0 4px;">未亮牌</span>`;
    }
    prHtml += `</div><span class="pr-hand">${p.handResult?p.handResult.name:(p.folded?'已弃牌':'-')}</span><span class="pr-net ${net>=0?'win':'lose'}">${net>=0?'+':''}${net}</span><span class="pr-chips">💰${p.chips}</span>`;
    // Folded players and an uncontested winner may choose to show their own hand.
    if (p.id===mySeatId&&p.holeCards?.length===2&&(p.folded||g.showdownOccurred===false&&g.winners.includes(p.id))) {
      prHtml += ` <button class="action-btn" data-show-hand="${p.id}" style="padding:2px 6px;font-size:10px;" onclick="toggleShowFolded()">${p.showFolded?'隐藏牌':'向全桌亮牌'}</button>`;
    }
    prHtml += `</div>`;
  });
  document.getElementById('playerResults').innerHTML = prHtml;
  const nextBtn = document.getElementById('nextHandBtn');
  const humans = PokerEngine.confirmationPlayers(g);
  const confirmed = g.nextHandReady || [];
  const finished = tournamentFinished(g);
  const mine = confirmed.includes(mySeatId);
  nextBtn.style.display = finished && !isHost ? 'none' : 'block';
  nextBtn.disabled = !finished && mine;
  nextBtn.textContent = finished ? '查看最终排名' : mine ? '已确认 · 等待其他玩家' : '确认下一局';
  document.getElementById('nextHandStatus').textContent = finished ? isHost?'本场已结束，点击下方按钮向所有玩家公布最终排名。':'本场已结束，等待房主公布排名…' : `下一局需要所有在线玩家确认 · ${humans.filter(p=>confirmed.includes(p.id)).length}/${humans.length}`;
  if(g.allowBuyIn) {
    const funded=g.players.filter(p=>!p.disconnected&&p.connected!==false&&(p.chips>0||p.isAI)).length;
    const minePlayer=g.players.find(p=>p.id===mySeatId);
    document.getElementById('nextHandStatus').textContent=funded<2?'至少需要两名有筹码的玩家，请先到银行买入。':`银行无限场 · 所有在线玩家确认后继续 · ${humans.filter(p=>confirmed.includes(p.id)).length}/${humans.length}`;
    if(!mine&&minePlayer?.chips===0)nextBtn.textContent='确认观战下一局 · 也可先到银行买入';
  }
  document.getElementById('nextHandPlayers').innerHTML = humans.map(p=>`<span class="confirmation-person ${confirmed.includes(p.id)?'confirmed':''}">${confirmed.includes(p.id)?'✓':'○'} ${escapeHtml(p.name)}</span>`).join('');
  if(!finished&&g.players.filter(p=>!p.disconnected&&p.connected!==false&&(p.chips>0||(g.allowBuyIn&&p.isAI))).length<2)document.getElementById('nextHandStatus').textContent=g.allowBuyIn?'至少需要两名有筹码的玩家。可邀请玩家加入，或到银行买入。':'至少需要两名有筹码的玩家。可邀请玩家加入或等待其他玩家返回。';
}

function toggleShowFolded() {
  if (isHost) {
    const p = g.players.find(p=>p.id===mySeatId);
    p.showFolded = !p.showFolded;
    broadcastGameState('result');
    showResultScreen(g);
  } else {
    ws.send(JSON.stringify({ type:'showFolded', seatId: mySeatId }));
  }
}

function startRaise() {
  const g = isHost ? window.g : clientGameState;
  raiseValue = g.currentBet + g.minRaise;
  raiseMode = true;
  renderGame(g);
}
function cancelRaise() {
  raiseMode = false;
  const g = isHost ? window.g : clientGameState;
  renderGame(g);
}
function confirmRaise() {
  raiseMode = false;
  if (isHost) {
    doRaiseHost(mySeatId, raiseValue);
  } else {
    sendAction('raise', raiseValue);
  }
}

function doRaiseHost(playerId, amount) {
  return handleAction(playerId, 'raise', amount);
}

function handleAction(seatId, action, amount, expected) {
  const result = PokerEngine.applyAction(g, seatId, action, amount, expected);
  if (result.ok) { raiseMode = false; syncAfterAction(); }
  else if (seatId !== mySeatId && seats[seatId]) {
    sendToPlayer(seatId, { type: 'actionRejected', message: result.message, game: serializeGame(g, seatId) });
  }
  return result;
}

function sendAction(action, amount) {
  if (!wsConnected || ws.readyState !== WebSocket.OPEN || actionPending || !clientGameState) return;
  const state = clientGameState;
  const actor = state.players[state.currentPlayerIndex];
  if (!actor || actor.id !== mySeatId || !PokerEngine.betting(state)) return;
  actionPending = true;
  ws.send(JSON.stringify({ type: 'action', seatId: mySeatId, action, amount,
    handNumber: state.handNumber, revision: state.revision }));
  renderGame(state);
}

function playerAction(action) {
  if (isHost) handleAction(mySeatId, action);
  else sendAction(action);
}

function scheduleAI() {
  clearTimeout(aiTimer);
  if (g && PokerEngine.betting(g) && g.players[g.currentPlayerIndex]?.isAI) {
    const revision = g.revision;
    aiTimer = setTimeout(() => { if (g && g.revision === revision) aiTurn(); }, 500);
  }
}

function syncAfterAction() {
  actionPending = false;
  if(g.phase==='tournament_over') {
    broadcastGameState('result');renderFinalRanking(g);
  } else if (g.phase === 'hand_over') {
    if (!tournamentFinished(g) && PokerEngine.allConfirmed(g) && startNewHand()) {
      showGameScreen();
      broadcastGameState('state');
      renderGame(g);
      scheduleAI();
      return;
    }
    broadcastGameState('result');
    showResultScreen(g);
  } else {
    broadcastGameState('state');
    renderGame(g);
  }
  scheduleAI();
}

function tournamentFinished(state) {
  return PokerEngine.sessionFinished(state,settings.minPlayers);
}

function nextHand() {
  const state = isHost ? g : clientGameState;
  if (!state || state.phase !== 'hand_over') return;
  if (isHost && tournamentFinished(state)) {
    g.phase = 'tournament_over';
    broadcastGameState('result');
    showGameOver(g.players.filter(p=>p.chips>0&&!p.disconnected));
    return;
  }
  if (isHost) {
    if (PokerEngine.confirmNextHand(g, mySeatId, g.handNumber)) syncAfterAction();
  } else if (wsConnected) {
    ws.send(JSON.stringify({ type:'handReady', handNumber:state.handNumber }));
    document.getElementById('nextHandBtn').disabled = true;
  }
}

function showGameOver() { renderFinalRanking(g); }
function showGameOverClient(state) { renderFinalRanking(state); }
function renderFinalRanking(state) {
  updateSessionTools(state);
  document.getElementById('gameScreen').style.display='none';
  document.getElementById('resultScreen').style.display='flex';
  const ranked=PokerEngine.standings({...state,players:state.players.filter(p=>p.hasPlayed!==false&&!p.removeAfterHand)});
  const leaders=ranked.filter(p=>p.place===1);
  let html='<div class="result-title">🏆 最终排名</div>';
  html+=`<div class="winners"><span class="winner-label">${leaders.length>1?'并列第一':'冠军'}:</span><span class="winner-names">${leaders.map(p=>escapeHtml(p.name)).join('、')}</span></div>`;
  html+='<ol class="final-ranking">';
  for(const p of ranked) {
    const tied=ranked.filter(other=>other.place===p.place).length>1;
    const medal=({1:'🥇',2:'🥈',3:'🥉'})[p.place]||`${p.place}.`;
    const detail=state.allowBuyIn?`筹码 ${p.chips} − 欠款 ${p.bankDebt}`:p.eliminatedHand!=null?`第 ${p.eliminatedHand} 局出局`:p.disconnected?'已退桌':'留桌';
    const amount=state.allowBuyIn?p.netChips:p.chips;
    html+=`<li class="ranking-row" data-seat="${p.id}" data-place="${p.place}"><span class="ranking-medal">${medal}</span><span class="ranking-player">${escapeHtml(p.name)}${p.isAI?'（人机）':''}<small>${tied?'并列 · ':''}${detail}</small>${state.allowBuyIn?`<small>累计贷款 ${p.totalBorrowed} · 已还 ${p.totalRepaid}</small>`:''}</span><span class="ranking-chips">${amount}${state.allowBuyIn?`<small>净筹码</small><small>净收益 ${p.netProfit>=0?'+':''}${p.netProfit}</small>`:''}</span></li>`;
  }
  html+=`</ol><p class="ranking-note">${state.allowBuyIn?'按现有筹码减未还贷款排名（含已退桌玩家）；净收益再扣除初始筹码。净筹码相同则并列。':'后出局者排名靠前；同局出局按本局起始筹码排序，筹码相同则并列。'}</p><button class="action-next" onclick="backToHome()">返回首页</button>`;
  document.querySelector('.result-card').innerHTML=html;
}

function updateSessionTools(state) {
  document.getElementById('sessionToolbar').hidden=false;document.getElementById('bankBtn').hidden=!state.allowBuyIn;
  document.getElementById('sessionMode').textContent=state.allowBuyIn?'银行无限场 · 无破产淘汰':'淘汰赛';
  const p=state.players.find(player=>player.id===mySeatId);
  document.getElementById('sessionStatus').textContent=state.endRequested?(state.phase==='tournament_over'?'整场已结算':'房主已申请结算，打完当前手后公布排名'):p?`筹码 ${p.chips} · 欠款 ${p.bankDebt} · 净筹码 ${p.chips-p.bankDebt}`:'';
  const finish=document.getElementById('finishSessionBtn');
  finish.hidden=!isHost||(!state.allowBuyIn&&!state.allowHostEnd);finish.disabled=!!state.endRequested||state.phase==='tournament_over'||!wsConnected;
  finish.textContent=state.endRequested?'已申请结算':'结算整局';
  finish.title='若本手仍在进行，会打完本手再结算';
  if(document.getElementById('bankDialog').open)renderBank(state);
}
function openBank() {
  const state=isHost?g:clientGameState;
  if(!state?.allowBuyIn)return;
  bankNotice='';renderBank(state);document.getElementById('bankDialog').showModal();
}
function renderBank(state) {
  const p=state.players.find(player=>player.id===mySeatId);
  if(!p)return;
  document.getElementById('bankChips').textContent=p.chips;
  document.getElementById('bankDebt').textContent=p.bankDebt;
  document.getElementById('bankNet').textContent=p.chips-p.bankDebt;
  const available=state.phase==='hand_over'&&!state.endRequested&&wsConnected&&!bankPending;
  const allowance=PokerEngine.loanAllowance(state,p),used=p.borrowHandNumber===state.handNumber?p.borrowedThisHand||0:0;
  const threshold=state.buyInThreshold==null?'筹码门槛不限':`筹码须低于 ${state.buyInThreshold}`;
  document.getElementById('bankLimits').textContent=`${threshold} · 每人每手贷款上限：${state.loanPerHandLimit??'无限'}（本手已借 ${used}） · 未还本金上限：${state.loanTotalLimit??'无限'} · 当前可再借：${Number.isFinite(allowance)?allowance:'无限'}。还款不恢复本手额度。`;
  document.getElementById('bankBorrowBtn').disabled=!available||allowance===0;
  document.getElementById('bankRepayBtn').disabled=!available||p.bankDebt===0||p.chips===0;
  document.getElementById('bankStatus').textContent=state.endRequested?'整场正在结算或已结束，银行不再接受交易。':PokerEngine.betting(state)?'本手进行中，仅可查看账户；本手结束后可借还款。':bankPending?'银行正在确认操作…':bankNotice||(!PokerEngine.belowBuyInThreshold(state,p)?'当前筹码已达到买入门槛，仍可还款。':'贷款增加筹码和欠款；还款同时扣减两者。交易后需要重新确认下一局。');
  document.getElementById('bankHistory').innerHTML=(state.bankLog||[]).filter(entry=>entry.seatId===mySeatId).slice(-10).reverse().map(entry=>`<div class="bank-entry"><span>第 ${entry.handNumber} 手 · ${entry.kind==='borrow'?'贷款买入':'还款'}</span><strong>${entry.kind==='borrow'?'+':'−'}${entry.amount}</strong><small>操作后欠款 ${entry.debt}</small></div>`).join('')||'<p class="bank-note">本场暂无借还款记录</p>';
}
function processBank(seatId,kind,amount,expected) {
  const result=PokerEngine.bankTransaction(g,seatId,kind,amount,expected);
  if(result.ok&&!result.duplicate)syncAfterAction();
  const message=result.ok?(result.duplicate?'该笔操作已处理，请核对账户。':'银行操作成功，下一局请重新确认。'):result.message;
  if(seatId!==mySeatId)sendToPlayer(seatId,{type:'bankResult',ok:result.ok,message,game:serializeGame(g,seatId)});
  else{bankPending=false;bankNotice=message;renderBank(g);}
  return result;
}
function submitBank(kind) {
  const state=isHost?g:clientGameState;
  if(!state?.allowBuyIn||bankPending||!wsConnected)return;
  const p=state.players.find(player=>player.id===mySeatId);
  const amount=Number(document.getElementById('bankAmount').value);
  const expected={handNumber:state.handNumber,bankVersion:p.bankVersion,requestId:`${mySeatId}-${Date.now()}-${++bankRequestSequence}`};
  bankPending=true;renderBank(state);
  if(isHost)processBank(mySeatId,kind,amount,expected);
  else ws.send(JSON.stringify({type:'bank',kind,amount,...expected}));
}
function finishSession() {
  if(!isHost||!g||!wsConnected)return;
  if(PokerEngine.requestSessionEnd(g,mySeatId).ok)syncAfterAction();
}

function backToHome() {
  document.getElementById('resultScreen').style.display='none';
  document.getElementById('gameScreen').style.display='none';
  document.getElementById('homeScreen').style.display='flex';
  // 重置
  if (isHost) {
    try { ws.close(); } catch(e) {}
  } else {
    try { ws.close(); } catch(e) {}
  }
  location.reload();
}

// ========== AI逻辑 ==========
function aiTurn() {
  if (!isHost || !g || !PokerEngine.betting(g)) return;
  const p = g.players[g.currentPlayerIndex];
  if (!p || !p.isAI || p.folded || p.allIn) return;
  const need = g.currentBet - p.currentBet;
  const rand = Math.random();
  if (need > 0 && rand < need / (g.pot + need) * .5) handleAction(p.id, 'fold');
  else if (rand > .85 && PokerEngine.canRaise(g, p)) {
    const amount = Math.min(PokerEngine.minimumRaiseTo(g), p.chips + p.currentBet);
    handleAction(p.id, amount > g.currentBet ? 'raise' : 'call', amount);
  } else handleAction(p.id, need > 0 ? 'call' : 'check');
}

// ========== 聊天 ==========
function sendChat() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  chatMessages.push({name: myName, text});
  input.value='';
  renderChat();
  ws.send(JSON.stringify({ type:'chat', name: myName, text: text }));
}
function sendQuickChat(idx) {
  const text = QUICK_CHATS[idx];
  chatMessages.push({name: myName, text});
  renderChat();
  ws.send(JSON.stringify({ type:'chat', name: myName, text: text }));
}
function renderChat() {
  document.getElementById('chatBox').innerHTML = chatMessages.map(m=>`<div class="chat-msg"><span class="chat-name">${escapeHtml(m.name)}:</span> ${escapeHtml(m.text)}</div>`).join('');
  document.getElementById('chatBox').scrollTop = 9999;
  document.getElementById('chatQuick').innerHTML = QUICK_CHATS.map((q,i)=>`<button class="chat-quick-btn" onclick="sendQuickChat(${i})">${q}</button>`).join('');
}

// ========== 房间逻辑 ==========
function setConnectionStatus(text, failed = false) {
  document.getElementById('waitTip').textContent = text;
  document.getElementById('waitTip').style.color = failed ? '#ff6b6b' : '#64b5f6';
}

function connectionFailed(text) {
  bankPending=false;
  clearTimeout(connectionTimer);
  wsConnected = false;
  setConnectionStatus(text, true);
  document.querySelector('.subtitle').textContent = text;
  renderSeats();
  if (g || clientGameState) renderGame(isHost ? g : clientGameState);
}

// WebSocket连接
function connectWS(onOpen) {
  clearTimeout(connectionTimer);
  if (ws) ws.close();
  wsConnected = false;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = protocol + '//' + location.host;
  const socket = new WebSocket(wsUrl);
  socket.binaryType = 'arraybuffer';
  ws = socket;
  connectionTimer = setTimeout(() => {
    if (ws !== socket) return;
    connectionFailed('连接超时，请确认服务器和房主在线后重新加入');
    socket.onclose = null;
    socket.close();
  }, 15000);
  socket.onopen = () => {
    if (ws !== socket) return;
    wsConnected = true;
    console.log('WebSocket connected');
    if (onOpen) onOpen();
  };
  socket.onmessage = (event) => {
    if (ws !== socket) return;
    if (event.data instanceof ArrayBuffer)return;
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'error' || data.type === 'roomClosed') {
        connectionFailed(data.message);
        socket.onclose = null;
        socket.close();
        return;
      }
      if (isHost) handleHostMessage(null, data);
      else handleClientMessage(data);
    } catch(e) { console.error(e); }
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    connectionFailed('连接已断开，请确认服务器在线后重新加入房间');
    console.log('WebSocket closed');
  };
  socket.onerror = (err) => {
    if (ws !== socket) return;
    connectionFailed('连接失败，请检查网络后重新加入房间');
    console.error('WebSocket error:', err);
  };
}

function createRoom() {
  roomCode = String(Math.floor(100000 + Math.random()*900000));
  isHost = true;
  seats = [{ id: 'host', name: myName, isHost: true, ready: true }];
  mySeatId = 0;

  document.querySelector('.subtitle').textContent = '正在创建房间...';
  showWaitScreen();
  setConnectionStatus('正在创建房间...');
  connectWS(() => {
    ws.send(JSON.stringify({ type:'joinRoom', roomCode: roomCode, seatId: 0, name: myName }));
  });
}

function joinRoom() {
  const code = document.getElementById('roomCodeInput').value.trim();
  if (!/^\d{6}$/.test(code)) { alert('请输入6位数字房间号'); return; }
  roomCode = code;
  isHost = false;
  mySeatId = -1;
  seats = [];
  wsConnected = false;

  showWaitScreen();
  setConnectionStatus('正在连接房间...');
  connectWS(() => {
    ws.send(JSON.stringify({ type:'joinRoom', roomCode: roomCode, seatId: -1, name: myName }));
  });
}

function sendToPlayer(seatId, msg) {
  // 通过WebSocket发送，服务器中继
  ws.send(JSON.stringify({ ...msg, targetSeat: seatId }));
}

function broadcastSeatsAll() {
  // 广播座位给所有房客
  for (let i = 1; i < seats.length; i++) {
    if (seats[i]) sendToPlayer(i, { type:'seats', seats: seats });
  }
}

function handleHostMessage(conn, data) {
  // 服务器通知有新玩家加入
  if (data.type === 'joined') {
    clearTimeout(connectionTimer);
    showWaitScreen();
    setConnectionStatus('房间已创建，等待玩家加入...');
  } else if (data.type === 'peerJoined') {
    const seatId = data.seatId;
    if (g) { sendToPlayer(seatId, { type:'error', message:'牌局已开始，请等待本场结束后加入新房间' }); return; }
    // 确保seats数组有足够位置
    while (seats.length < seatId) {
      seats.push(null);
    }
    seats[seatId] = { id: 'client-'+seatId, name: data.name, isHost: false, ready: false };
    delete aiSlots[seatId];
    if (maxPlayers <= seatId) {
      maxPlayers = seatId + 1;
    }
    // 发joined给新房客
    sendToPlayer(seatId, { type:'joined', seatId: seatId, seats: seats });
    // 更新房主界面
    broadcastSeats();
    broadcastSettings();
  } else if (data.type === 'peerLeft') {
    if (seats[data.seatId]) {
      seats[data.seatId] = null;
    }
    if (g) { PokerEngine.disconnect(g, data.seatId); syncAfterAction(); }
    else broadcastSeats();
  } else if (data.type === 'ready') {
    if (seats[data.seatId]) { seats[data.seatId].ready = true; }
    broadcastSeats();
  } else if (data.type === 'action') {
    if (!g) return;
    handleAction(data.seatId, data.action, data.amount, data);
  } else if (data.type === 'handReady') {
    if (PokerEngine.confirmNextHand(g, data.seatId, data.handNumber)) syncAfterAction();
  } else if (data.type === 'bank') {
    if(g)processBank(data.seatId,data.kind,data.amount,data);
  } else if (data.type === 'chat') {
    broadcast({ type:'chat', name: data.name, text: data.text });
  } else if (data.type === 'raise') {
    if (g) handleAction(data.seatId, 'raise', data.amount, data);
  } else if (data.type === 'showFolded') {
    const p = g?.players.find(p=>p.id===data.seatId);
    if (g?.phase === 'hand_over' && p?.folded) {
      p.showFolded = !p.showFolded;
      broadcastGameState('result');
      showResultScreen(g);
    }
  }

}

function handleClientMessage(data) {
  if (data.game && ['gameStart','state','result','actionRejected'].includes(data.type)) {
    actionPending = false;
    raiseMode = false;
  }
  if (data.type === 'seats') {
    seats = data.seats;
    if (clientGameState) return;
    showWaitScreen();
    renderSeats();
    if (mySeatId >= 0) setConnectionStatus(seats[mySeatId]?.ready ? '已准备，等待房主开始游戏' : '已连接房间，请点击准备');
  } else if (data.type === 'settings') {
    maxPlayers = data.maxPlayers;
    settings = data.settings;
    aiSlots = data.aiSlots || {};
    renderSeats();
  } else if (data.type === 'joined') {
    if (!data.seats || !data.seats[data.seatId]) return;
    clearTimeout(connectionTimer);
    mySeatId = data.seatId;
    if (data.seats) {
      seats = data.seats;
    }
    showWaitScreen();
    renderSeats();
    setConnectionStatus('已连接房间，请点击准备');
  } else if (data.type === 'gameStart') {
    showGameScreen();
    clientGameState = data.game;
    renderGame(data.game);
  } else if (data.type === 'bankResult') {
    bankPending=false;bankNotice=data.message;clientGameState=data.game;
    if(data.game.phase==='tournament_over')renderFinalRanking(data.game);
    else if(data.game.phase==='hand_over')showResultScreen(data.game);
    else renderGame(data.game);
    if(document.getElementById('bankDialog').open)renderBank(data.game);
  } else if (data.type === 'actionRejected') {
    clientGameState = data.game;
    if (data.game.phase === 'hand_over') showResultScreen(data.game);
    else {
      renderGame(data.game);
      document.getElementById('actionHint').textContent = data.message;
    }
  } else if (data.type === 'state') {
    clientGameState = data.game;
    // 确保从结算/等待界面切回游戏界面
    document.getElementById('resultScreen').style.display='none';
    document.getElementById('waitScreen').style.display='none';
    document.getElementById('homeScreen').style.display='none';
    document.getElementById('gameScreen').style.display='flex';
    renderGame(data.game);
  } else if (data.type === 'result') {
    clientGameState = data.game;
    if (data.game.phase === 'tournament_over') {
      showGameOverClient(data.game);
    } else {
      showResultScreen(data.game);
    }
  } else if (data.type === 'chat') {
    chatMessages.push({name: data.name, text: data.text});
    renderChat();
  }
}

function tableInviteUrl() {
  const path=lobbyLeague?.id?'/?leagueMatch='+encodeURIComponent(lobbyLeague.id):'/#room='+roomCode;
  return window.location.origin+path;
}

async function copyTableInvite() {
  const url=tableInviteUrl();
  try { await navigator.clipboard.writeText(url); }
  catch (_) { window.prompt('复制房间链接',url);return; }
  document.getElementById('connectionText').textContent='房间邀请链接已复制';
}

function showWaitScreen() {
  document.getElementById('homeScreen').style.display = 'none';
  document.getElementById('waitScreen').style.display = 'flex';
  document.getElementById('displayRoomCode').textContent = roomCode;
  const shareUrl = tableInviteUrl();
  document.getElementById('shareLink').textContent = '分享链接: ' + shareUrl;
  document.getElementById('shareLink').onclick = copyTableInvite;
  document.getElementById('shareLink').onkeydown = event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); document.getElementById('shareLink').click(); }
  };
  document.getElementById('readyBtn').style.display = isHost ? 'none' : 'block';
  document.getElementById('startBtn').style.display = 'none';
  document.getElementById('settingsPanel').style.display = isHost ? 'block' : 'none';
  renderSeats();
}

function onSettingsChange() {
  if(g)return;
  const readLimit=id=>{const raw=document.getElementById(id).value.trim();return ['','无限','不限'].includes(raw)?null:/^\d+$/.test(raw)?Number(raw):NaN;};
  const perHand=readLimit('loanPerHandLimit'),total=readLimit('loanTotalLimit');
  const threshold=readLimit('buyInThreshold');
  if(![perHand,total,threshold].every(PokerEngine.validLoanLimit)){alert('贷款限额和买入门槛请输入0或正整数，也可设为不限');return;}
  settings.loanPerHandLimit=perHand;settings.loanTotalLimit=total;settings.buyInThreshold=threshold;
  settings.bigBlind = parseInt(document.getElementById('bigBlindSel').value);
  settings.initChips = parseInt(document.getElementById('initChipsSel').value);
  settings.minPlayers = parseInt(document.getElementById('minPlayersSel').value);
  settings.allowBuyIn = document.getElementById('allowBuyInSel').value==='yes';
  settings.showWinRate = document.getElementById('showWinRateSel').value!=='no';
  settings.runoutDelayMs=Number(document.getElementById('runoutDelaySel').value||3000);
  document.getElementById('minPlayersSel').disabled=settings.allowBuyIn;
  broadcastSettings();
}
function broadcastSettings() {
  broadcast({ type:'settings', maxPlayers: maxPlayers, settings: settings, aiSlots: aiSlots });
}

// 准备按钮
document.getElementById('readyBtn').onclick = () => {
  const seat = seats[mySeatId];
  if (isHost || !seat || seat.ready || !wsConnected || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type:'ready', seatId: mySeatId, targetSeat: 0 }));
  setConnectionStatus('准备请求已发送，等待房主确认...');
};

// 开始游戏（房主）
document.getElementById('startBtn').onclick = () => {
  if (!isHost || !wsConnected || seats.some(s => s && !s.isHost && s.connected!==false && !s.ready)) return;
  startGameHost();
};

// 离开
document.getElementById('leaveBtn').onclick = () => {
  try { ws.close(); } catch(e) {}
  location.reload();
};

// 首页按钮
// 创建房间
document.getElementById('createBtn').onclick = () => {
  createRoom();
};

// 加入房间
document.getElementById('joinBtn').onclick = () => {
  document.getElementById('roomCodeInput').style.display = 'block';
  document.getElementById('confirmJoinBtn').style.display = 'block';
  document.getElementById('roomCodeInput').focus();
};
document.getElementById('confirmJoinBtn').onclick = () => {
  joinRoom();
};

// 昵称输入
document.getElementById('nameInput').addEventListener('input', (e) => {
  myName = e.target.value.trim() || '玩家' + Math.floor(Math.random()*100);
  localStorage.setItem('starstone_name', myName);
});

// 检查URL是否带房间号
window.onload = () => {
  // 初始化昵称
  const saved = localStorage.getItem('starstone_name');
  if (saved) myName = saved;
  document.getElementById('nameInput').value = myName;

  const hash = window.location.hash;
  const match = hash.match(/room=(\d{6})/);
  if (match) {
    document.getElementById('roomCodeInput').value = match[1];
    joinRoom();
  }
};
