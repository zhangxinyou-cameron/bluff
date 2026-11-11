/* View-only table interactions. Every mutation is validated by RoomManager. */
(() => {
  'use strict';
  const el=id=>document.getElementById(id),esc=value=>escapeHtml(value);
  let data=null,playing=false,lastTurn='',catalogKey='',targetKey='',inboxKey='';
  let socialTab='gifts',noticeTimer=null,feedbackTimer=null,toastTimer=null,activePeek='',replyPending='';
  const bubbles=new Map();
  const cmd=(type,payload={})=>window.RiverSession.command(type,payload);
  const state=()=>data?.game;
  const name=id=>state()?.players.find(p=>p.id===id)?.name||data?.roster.find(p=>p.id===id)?.name||'玩家';
  el('avatarBtn').insertAdjacentHTML('afterend','<button id="peekSettingsBtn" class="sound-button" onclick="RiverTable.openPeekSettings()">看牌门槛 · 手动</button>');
  el('socialAudience').insertAdjacentHTML('afterend','<span id="socialPeekThreshold" class="social-threshold"></span>');
  const thresholdText=value=>value==null?'手动确认':`小费 ≥ ${value} 筹码自动同意`;
  const myThreshold=()=>data?.roster?.find(p=>p.id===mySeatId)?.peekThreshold??null;
  function openPeekSettings(){if(!data)return;const value=myThreshold();el('peekAutoEnabled').checked=value!=null;el('peekThresholdAmount').value=value??0;el('peekThresholdAmount').disabled=value==null;el('peekThresholdCurrent').textContent='当前公开设置：'+thresholdText(value);if(!el('peekSettingsDialog').open)el('peekSettingsDialog').showModal();}
  function savePeekSettings(){const raw=el('peekThresholdAmount').value,value=el('peekAutoEnabled').checked?Number(raw):null;if(value!==null&&(raw.trim()===''||!Number.isSafeInteger(value)||value<0)){toast('门槛请输入非负整数',false);return;}cmd('peekThreshold',{threshold:value});}
  document.body.insertAdjacentHTML('beforeend','<div id="tableFeedback" class="table-feedback" popover="manual" hidden role="status" aria-live="polite"></div>');
  function toast(message,ok=true){const box=el('tableFeedback');clearTimeout(toastTimer);box.textContent=message;box.dataset.state=ok?'success':'warning';box.hidden=false;try{box.showPopover?.();}catch(_){}toastTimer=setTimeout(()=>{try{box.hidePopover?.();}catch(_){}box.hidden=true;},3500);}
  function avatarUI(){
    const mine=state()?.players.find(p=>p.id===mySeatId)||data?.roster?.find(p=>p.id===mySeatId),id=mine?.avatar||RiverAvatars.read(),avatar=RiverAvatars.get(id);
    if(mine?.avatar)RiverAvatars.save(id);
    for(const buttonId of ['avatarBtn','homeAvatarBtn']){el(buttonId).innerHTML=RiverAvatars.markup(id)+'<span>头像 · '+avatar.name+'</span>';}
    el('avatarChoices').innerHTML=RiverAvatars.items.map(item=>`<button class="avatar-choice" data-avatar="${item.id}" aria-pressed="${item.id===id}" ${data&&!wsConnected||window.RiverSession?.getDiagnostics().pending?'disabled':''}>${RiverAvatars.markup(item.id)}<span>${item.name}</span><small>${item.id===id?'已选择':'选择头像'}</small></button>`).join('');
  }
  function openAvatar(){avatarUI();if(!el('avatarDialog').open)el('avatarDialog').showModal();}
  function peekClock(now){
    const requests=(state()?.phase==='tournament_over'?[]:data?.peekRequests||[]).filter(r=>r.to===mySeatId&&r.status==='pending'&&r.expiresAt>now),dialog=el('peekConsentDialog');
    const request=requests.find(r=>r.id===activePeek)||requests[0];
    if(!request){if(dialog.open)dialog.close();activePeek='';replyPending='';return;}
    const changed=activePeek!==request.id;
    if(changed){activePeek=request.id;replyPending='';el('peekConsentFrom').textContent=name(request.from)+' 想看看你的手牌';el('peekConsentTip').textContent=(request.tip?'自愿小费 '+request.tip+' 筹码，本手结算后转账。':'未附小费。')+' 同意后仅向申请者亮牌。';}
    const seconds=Math.max(0,Math.ceil((request.expiresAt-now)/1000));el('peekConsentSeconds').textContent=String(seconds);
    dialog.style.setProperty('--peek-progress',Math.min(100,seconds*10)+'%');
    el('peekConsentQueue').textContent=requests.length>1?`还有 ${requests.length-1} 个申请等待答复`:'10秒内有效 · 超时自动拒绝，不扣小费';
    for(const id of ['peekConsentAccept','peekConsentDecline'])el(id).disabled=!!replyPending||!wsConnected||!!window.RiverSession?.getDiagnostics().pending;
    if(!dialog.open&&!document.hidden){hideTurnNotice();dialog.showModal();el('peekConsentDecline').focus();window.RiverAudio?.play('ready');}
  }
  function replyPeek(accept,id=activePeek){if(!id||replyPending)return;if(cmd('peekReply',{peekId:id,accept})){replyPending=id;for(const button of el('peekConsentDialog').querySelectorAll('button'))button.disabled=true;}}
  el('tableBlindMode').insertAdjacentHTML('beforeend','<option value="standard">标准：SB半倍 / BB1倍</option>');
  const giftCaptions={tomato:'来点热闹',coffee:'慢慢想，喝一杯',flower:'好牌与好运',cheers:'为这一手干杯'};
  function giftArt(id,fallback='♠'){
    const paths={
      tomato:'<path fill="#b9614d" stroke="#e1a18a" d="M18 28C9 30 9 47 17 54c6 6 24 6 30 0 9-8 8-24-1-27-8-3-12 1-14 1s-6-4-14 0Z"/><path fill="#809768" stroke="#a4b283" d="m32 29-12-7 10 1 3-11 3 11 11-2-12 9-3 7Z"/><path stroke="#e7b39a" d="M20 37c-3 3-3 7-1 10"/>',
      coffee:'<path fill="#cfba8c" fill-opacity=".18" d="M15 27h30v14c0 13-30 13-30 0Z"/><path d="M15 27h30v14c0 13-30 13-30 0Zm30 2h4c10 0 10 13-4 13M10 54h42M23 19c-6-7 5-7 0-14m11 14c-6-7 5-7 0-14"/>',
      flower:'<path stroke="#819d76" d="m32 52 2-24m-1 14c-11 0-14-8-14-8 11-1 14 8 14 8Zm1 4c10 0 14-8 14-8-10-1-14 8-14 8Z"/><path fill="#b77579" fill-opacity=".5" stroke="#db9d9c" d="M34 29c-13 1-19-11-12-15-2-9 8-12 12-5 6-8 16-2 12 5 9 6 0 16-12 15Z"/><path stroke="#db9d9c" d="M27 16c8-2 14 2 10 7-7 3-13-5-5-9"/>',
      cheers:'<path fill="#cfba8c" fill-opacity=".16" d="m13 17 15-4 7 22-15 4Zm23-4 15 4-7 22-15-4Z"/><path d="m13 17 15-4 7 22c-1 8-12 11-15 4Zm23-4 15 4-7 22c-3 9-14 5-15-4ZM27 43l4 12m-11 2 17-5m0-9-4 12m-5-3 16 5M17 27l14-4m3 0 14 4M32 5v4m-11-4 3 4m19-4-3 4"/>'
    };
    return paths[id]?`<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[id]}</svg>`:`<span aria-hidden="true">${esc(fallback)}</span>`;
  }
  function people(){const map=new Map((data?.roster||[]).filter(p=>!p.kicked&&!p.retired).map(p=>[p.id,p]));for(const p of state()?.players||[])if(!p.disconnected)map.set(p.id,p);return[...map.values()].filter(p=>p.id!==mySeatId);}
  function update(value){data=value;}
  function layout(value,remaining){
    data=value;const game=value.game,next=!!game&&(!['hand_over','tournament_over'].includes(game.phase)||remaining>0);
    el('sessionToolbar').hidden=false;
    for(const id of ['tableDeckMode','deckModeSel']){el(id).value=value.settings.deckMode||'auto';el(id).disabled=!isHost||!!game&&!['hand_over','tournament_over'].includes(game.phase)||!wsConnected;}
    for(const id of ['tableBlindMode','blindModeSel']){el(id).value=value.settings.blindMode||'auto';el(id).disabled=!isHost||!!game&&game.phase!=='hand_over'||!wsConnected;}
    if(value.league&&game)for(const id of ['tableDeckMode','tableBlindMode'])el(id).disabled=true;
    el('peekSettingsBtn').hidden=value.league?.mode==='team';
    el('managePlayersBtn').hidden=!isHost;el('closeRoomBtn').hidden=!isHost;el('bankBtn').hidden=!game?.allowBuyIn;el('finishSessionBtn').hidden=!isHost||(!game?.allowBuyIn&&!game?.allowHostEnd);
    if(!game){el('sessionMode').textContent='牌桌设置';el('sessionStatus').textContent='暂时离桌保留原位30分钟 · 同一浏览器重新入房恢复';render(value,false);}
    el('playWorkspace').classList.toggle('is-playing',next);document.body.classList.toggle('in-game',next);
    if(next!==playing){playing=next;if(next){el('historyFilter').value='chat';requestAnimationFrame(()=>el('playWorkspace').scrollIntoView({block:'start',behavior:'instant'}));}else if(game)requestAnimationFrame(()=>el('resultScreen').scrollIntoView({block:'start',behavior:'instant'}));}
  }
  function render(value,locked){
    data=value;const game=value.game,me=game?.players.find(p=>p.id===mySeatId),options=people();
    const key=JSON.stringify(options.map(p=>[p.id,p.name,p.connected]));
    if(key!==targetKey){targetKey=key;const selected=el('socialTarget').value;el('socialTarget').innerHTML=options.length?options.map(p=>`<option value="${p.id}">${esc(p.name)}${p.connected===false?'（暂离）':''}</option>`).join(''):'<option value="">暂无其他玩家</option>';if(options.some(p=>String(p.id)===selected))el('socialTarget').value=selected;}
    const packKey=JSON.stringify(value.packs);
    if(packKey!==catalogKey){catalogKey=packKey;
      el('phraseButtons').innerHTML=(value.packs?.phrases||[]).map(p=>`<button class="phrase-choice" data-phrase="${esc(p.id)}"><span class="phrase-quote" aria-hidden="true">“</span><span class="phrase-copy"><strong>${esc(p.text)}</strong><small>${p.audio?'语音与文字':'快捷文字'}</small></span><span class="phrase-send" aria-hidden="true">↗</span></button>`).join('');
      el('giftButtons').innerHTML=(value.packs?.gifts||[]).map(g=>`<button class="gift-choice" data-gift="${esc(g.id)}"><span class="gift-art gift-art-${esc(g.id)}">${giftArt(g.id,g.emoji)}</span><strong>${esc(g.label)}</strong><small>${esc(giftCaptions[g.id]||'送一份心意')}</small><span class="gift-send" aria-hidden="true">↗</span></button>`).join('');
    }
    const requests=value.peekRequests||[],incoming=requests.filter(r=>r.to===mySeatId&&r.status==='pending'),count=incoming.length;
    el('peekBadge').textContent=count?String(count):'';el('tableSocialBtn').classList.toggle('has-request',!!count);
    el('socialRequestCount').hidden=!count;el('socialRequestCount').textContent=count;el('socialHostActions').hidden=!isHost;
    const requestsKey=JSON.stringify(requests);
    if(requestsKey!==inboxKey){inboxKey=requestsKey;
      el('peekInbox').innerHTML=incoming.map(r=>`<div class="peek-request"><span class="request-eyebrow">收到看牌申请</span><strong>${esc(name(r.from))} 想看看你的牌</strong><small>${r.tip?'自愿小费 '+r.tip+' · 本手结算后转账':'未附小费'} · 10秒内有效</small><div><button class="peek-accept" data-peek="${esc(r.id)}" data-accept="true">同意，仅向TA亮牌</button><button class="peek-decline" data-peek="${esc(r.id)}" data-accept="false">婉拒</button></div></div>`).join('');
      const outgoing=requests.filter(r=>r.from===mySeatId);el('peekOutbox').hidden=!outgoing.length;
      el('peekOutbox').innerHTML=outgoing.map(r=>`<div class="peek-receipt" data-state="${esc(r.status)}"><span>${esc(name(r.to))}</span><strong>${esc({pending:'等待答复',approved:'已同意 · 仅你可见',declined:'对方已婉拒',expired:'申请已过期'}[r.status]||r.status)}</strong></div>`).join('');
    }
    targetChanged();avatarUI();peekClock(window.RiverSession.getDiagnostics().serverNow);
    el('peekSettingsBtn').textContent='看牌门槛 · '+(myThreshold()==null?'手动':myThreshold()+'筹码');
    el('positionGuide').hidden=!game?.actionOrder;
    if(game?.actionOrder){const row=(label,ids)=>`<div class="position-order"><strong>${label}</strong>${ids.map(id=>{const p=game.players.find(p=>p.id===id);return `<span class="position-chip ${id===mySeatId?'is-me':''}"><b>${esc(p.position?.label||'')}</b>${esc(p.name)}</span>`;}).join('<i aria-hidden="true">→</i>')}</div>`;
      el('positionGuideContent').innerHTML=`<p>${game.blindRule==='ante'?'全员底注模式按BTN＋距离显示位置，翻前从庄家左手第一位开始。':game.blindRule==='position'?'自定义盲注：庄家左手第一位BB付1倍，第二位SB付半倍。':'标准位置制：庄家左手第一位SB付半倍，第二位BB付1倍；两人桌庄家兼任SB。'} 以下为开局顺序，实际行动跳过已弃牌、梭哈及未参与者。</p>${row('翻前',game.actionOrder.preflop)}${row('翻后',game.actionOrder.postflop)}`;}
    for(const item of bubbles.values())showBubble(item);
    const vote=value.runoutVote,panel=el('runoutPanel');panel.hidden=game?.phase!=='runout_vote';
    if(!panel.hidden){const eligible=vote?.eligibleIds.includes(mySeatId),yes=vote?.yesIds.includes(mySeatId);
      panel.innerHTML=`<div><strong>梭哈协商 · 发两次？</strong><span id="voteCountdown"></span><small>每个主池/边池各分两份；需全员同意，超时或拒绝则发一次。</small><span>${vote.yesIds.length}/${vote.eligibleIds.length} 已同意 · ${vote.eligibleIds.map(id=>esc(name(id))+(vote.yesIds.includes(id)?' ✓':'')).join('、')}</span></div>${eligible?`<button id="voteTwiceBtn" class="action-btn" ${yes||locked?'disabled':''} onclick="RiverTable.vote(true)">${yes?'已同意 · 等待他人':'同意发两次'}</button><button id="voteOnceBtn" class="action-btn" ${locked?'disabled':''} onclick="RiverTable.vote(false)">发一次</button>`:'<span>等待争池玩家协商</span>'}`;
    }
  }
  function targetChanged(){
    const game=state(),me=game?.players.find(p=>p.id===mySeatId),target=game?.players.find(p=>p.id===Number(el('socialTarget').value));
    const selected=people().find(p=>p.id===Number(el('socialTarget').value)),busy=!!window.RiverSession?.getDiagnostics().pending;
    el('socialAvatar').innerHTML=RiverAvatars.markup(selected?.avatar);
    el('socialPresence').textContent=selected?selected.connected===false?'暂离':selected.isAI?'人机':'在桌':'';
    el('socialPresence').dataset.online=String(!!selected&&selected.connected!==false);
    el('socialPeekThreshold').textContent=selected&&!selected.isAI?'对方看牌门槛：'+thresholdText(selected.peekThreshold):'';
    el('socialAudience').textContent=socialTab==='phrases'?'语言包会发送给整桌朋友':socialTab==='peek'?'由这位玩家决定是否向你亮牌':'礼物将送到所选玩家座位';
    const request=data?.peekRequests?.find(r=>r.from===mySeatId&&r.to===target?.id);
    const can=data?.league?.mode!=='team'&&!!game&&PokerEngine.canRequestPeek(me)&&game.phase!=='tournament_over'&&!!target&&!target.isAI&&!target.disconnected&&target.connected!==false&&!request;
    el('requestPeekBtn').disabled=!can||!wsConnected||busy;
    el('peekHelp').textContent=request?request.status==='pending'?'申请已发送，等待对方答复。':'本手已向这位玩家申请过，可查看上方结果。':can?me.chips===0?'观战也可申请看牌，无筹码时小费填0；需对方同意。':'小费于本手结算后转账；对方拒绝或申请过期均不扣款。':'本手弃牌或无筹码观战时，可向在线真人申请看牌。';
    for(const button of el('giftButtons').querySelectorAll('button'))button.disabled=!selected||!wsConnected||busy;
    for(const button of el('phraseButtons').querySelectorAll('button'))button.disabled=!wsConnected||busy;
    el('kickPlayerBtn').hidden=!isHost;el('kickPlayerBtn').disabled=!el('socialTarget').value||!wsConnected;
  }
  function setTab(tab,focus=false){
    if(!['gifts','phrases','peek'].includes(tab))return;socialTab=tab;
    for(const button of document.querySelectorAll('[data-social-tab]')){const active=button.dataset.socialTab===tab;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;el(button.getAttribute('aria-controls')).hidden=!active;if(active&&focus)button.focus();}
    el('socialDialog').dataset.tab=tab;targetChanged();
  }
  function open(target,tab){if(!data)return;render(data,false);if(target!==undefined&&target!==mySeatId)el('socialTarget').value=String(target);
    const incoming=data.peekRequests?.some(r=>r.to===mySeatId&&r.status==='pending');setTab(tab==='manage'?'gifts':tab||incoming&&'peek'||'gifts');el('socialHostActions').open=tab==='manage';
    clearTimeout(feedbackTimer);el('socialFeedback').textContent='轻松互动，享受每一手好牌。';el('socialFeedback').dataset.state='';
    if(!el('socialDialog').open)el('socialDialog').showModal();
  }
  function hideTurnNotice(){clearTimeout(noticeTimer);const notice=el('turnNotice');try{notice.hidePopover?.();}catch(_){}notice.hidden=true;}
  function showTurnNotice(game,seconds){
    hideTurnNotice();const notice=el('turnNotice'),me=game.players.find(p=>p.id===mySeatId),need=Math.max(0,game.currentBet-me.currentBet);
    notice.querySelector('.turn-notice-eyebrow').textContent='YOUR TURN'+(me.position?' · '+me.position.label:'');
    el('turnNoticeDetail').textContent=need?`跟注 ${Math.min(need,me.chips)} · 加注 · 弃牌`:'过牌 · 加注 · 弃牌';el('turnNoticeSeconds').textContent=Math.ceil(seconds)+'s';notice.hidden=false;
    try{notice.showPopover?.();}catch(_){}
    noticeTimer=setTimeout(hideTurnNotice,1650);
  }
  function clock(value,now,locked){
    peekClock(now);
    const game=value.game,vote=value.runoutVote,remaining=Math.max(0,(value.turnDeadline-now)/1000),isTurn=PokerEngine.betting(game||{})&&game.players[game.currentPlayerIndex]?.id===mySeatId&&!locked&&now>=value.interactiveAt;
    const cue=el('turnCue');cue.dataset.active=String(isTurn);cue.dataset.urgent=String(isTurn&&remaining<=10);
    el('turnSeconds').textContent=PokerEngine.betting(game||{})?Math.ceil(remaining)+'s':game?.phase==='runout_vote'?'协商':'等待';
    el('turnProgress').style.width=Math.max(0,Math.min(100,remaining/60*100))+'%';
    if(vote&&el('voteCountdown'))el('voteCountdown').textContent=`${Math.max(0,Math.ceil((vote.expiresAt-now)/1000))} 秒`;
    const key=`${value.roomCode}-${game?.handNumber}-${game?.currentPlayerIndex}-${value.turnDeadline}`;
    if(isTurn){document.title='轮到你 · THE RIVER';if(!document.hidden&&!el('peekConsentDialog').open&&lastTurn!==key){lastTurn=key;showTurnNotice(game,remaining);window.RiverAudio?.play('ready');}else if(!el('turnNotice').hidden)el('turnNoticeSeconds').textContent=Math.ceil(remaining)+'s';}
    else{hideTurnNotice();document.title='THE RIVER · 私人牌桌';}
  }
  function showBubble(item){
    const card=document.querySelector(`.player-card[data-seat="${item.seatId}"]`);if(card&&!card.querySelector('.speech-bubble')){const bubble=document.createElement('span');bubble.className='speech-bubble';bubble.textContent=item.text;card.append(bubble);}
  }
  function event(item){if(Date.now()-item.time<=5000)requestAnimationFrame(()=>showEvent(item));}
  function showEvent(item){
    if(Date.now()-item.time>5000||document.hidden||!playing)return;
    if(item.kind==='phrase'){
      const phrase=data?.packs?.phrases.find(p=>p.id===item.phraseId);if(phrase?.audio)window.RiverAudio?.playPack(phrase.audio);
      bubbles.set(item.seatId,item);showBubble(item);setTimeout(()=>{if(bubbles.get(item.seatId)===item){bubbles.delete(item.seatId);document.querySelector(`.player-card[data-seat="${item.seatId}"] .speech-bubble`)?.remove();}},4500);
    }
    if(item.kind==='gift'){
      const gift=data?.packs?.gifts.find(g=>g.id===item.giftId),from=document.querySelector(`.player-card[data-seat="${item.from}"]`),to=document.querySelector(`.player-card[data-seat="${item.to}"]`),layer=el('reactionLayer');
      if(!gift||!from||!to||layer.childElementCount>=8)return;
      const a=from.getBoundingClientRect(),b=to.getBoundingClientRect(),base=layer.getBoundingClientRect(),node=document.createElement('span');node.className='gift-flight gift-'+gift.id;node.innerHTML=giftArt(gift.id,gift.emoji);
      node.style.left=a.x+a.width/2-base.x+'px';node.style.top=a.y+a.height/2-base.y+'px';node.style.setProperty('--gift-x',b.x+b.width/2-a.x-a.width/2+'px');node.style.setProperty('--gift-y',b.y+b.height/2-a.y-a.height/2+'px');layer.append(node);setTimeout(()=>node.remove(),2200);
    }
  }
  el('phraseButtons').addEventListener('click',e=>{const button=e.target.closest('[data-phrase]');if(button)cmd('phrase',{phraseId:button.dataset.phrase});});
  el('giftButtons').addEventListener('click',e=>{const button=e.target.closest('[data-gift]');if(button&&!button.disabled&&cmd('gift',{giftId:button.dataset.gift,target:Number(el('socialTarget').value)}))el('socialDialog').close();});
  el('peekInbox').addEventListener('click',e=>{const button=e.target.closest('[data-peek]');if(button)replyPeek(button.dataset.accept==='true',button.dataset.peek);});
  el('peekConsentAccept').onclick=()=>replyPeek(true);el('peekConsentDecline').onclick=()=>replyPeek(false);
  el('peekConsentDialog').addEventListener('cancel',e=>{e.preventDefault();replyPeek(false);});
  el('avatarChoices').addEventListener('click',async e=>{
    const button=e.target.closest('button[data-avatar]');if(!button||button.disabled)return;
    const id=button.dataset.avatar;
    if(data&&wsConnected){cmd('avatar',{avatar:id});return;}
    if(!data)try{await window.RiverSession.saveHomeAvatar(id);avatarUI();el('avatarDialog').close();}
    catch(error){toast(error.message,false);}
  });
  document.querySelector('.social-tabs').addEventListener('click',e=>{const button=e.target.closest('[data-social-tab]');if(button)setTab(button.dataset.socialTab);});
  document.querySelector('.social-tabs').addEventListener('keydown',e=>{const tabs=['gifts','phrases','peek'],index=tabs.indexOf(e.target.closest('[data-social-tab]')?.dataset.socialTab||socialTab);if(['ArrowRight','ArrowLeft','Home','End'].includes(e.key)){e.preventDefault();setTab(e.key==='Home'?tabs[0]:e.key==='End'?tabs[2]:tabs[(index+(e.key==='ArrowRight'?1:2))%3],true);}});
  el('managePlayersBtn').onclick=()=>open(undefined,'manage');
  el('phraseOpenBtn').onclick=()=>open(undefined,'phrases');
  document.addEventListener('visibilitychange',()=>{if(document.hidden)hideTurnNotice();});
  function feedback(ack,request){
    if(ack.command==='peekThreshold'){if(ack.ok)el('peekSettingsDialog').close();toast(ack.message||'门槛设置已处理',ack.ok);return;}
    if(ack.command==='avatar'){if(ack.ok){RiverAvatars.save(request?.avatar||RiverAvatars.read());el('avatarDialog').close();avatarUI();}toast(ack.ok?'头像已更新':ack.message||'头像更新失败',ack.ok);return;}
    if(ack.command==='peekReply'){if(replyPending===request?.peekId)replyPending='';if(ack.ok){if(activePeek===request?.peekId)el('peekConsentDialog').close();}else toast(ack.message||'申请已过期',false);}
    if(ack.command==='gift'){toast(ack.ok?`已向 ${name(request?.target)} ${data?.packs?.gifts.find(g=>g.id===request?.giftId)?.label||'送出心意'}`:ack.message||'互动未发送，请重试',ack.ok);}
    if(!el('socialDialog').open||!['phrase','gift','peekRequest','peekReply','kick'].includes(ack.command))return;
    let message=ack.message;
    if(ack.ok&&!message){if(ack.command==='phrase')message='这句话已送到整桌朋友的聊天里。';else if(ack.command==='gift')message=`已向 ${name(request?.target)} ${data.packs.gifts.find(g=>g.id===request?.giftId)?.label||'送出心意'}。`;else if(ack.command==='peekReply')message='已婉拒这次看牌申请。';else if(ack.command==='kick')message='已将所选玩家移出房间。';}
    el('socialFeedback').textContent=message||'操作已处理';el('socialFeedback').dataset.state=ack.ok?'success':'warning';
    clearTimeout(feedbackTimer);feedbackTimer=setTimeout(()=>{el('socialFeedback').textContent='轻松互动，享受每一手好牌。';el('socialFeedback').dataset.state='';},4000);
  }
  function raiseTo(amount){raiseValue=Math.round(amount);renderGame(state());}
  function raiseInput(value){const game=state(),me=game.players.find(p=>p.id===mySeatId);raiseValue=Math.max(game.currentBet+game.minRaise,Math.min(me.chips+me.currentBet,Math.floor(Number(value)||0)));const slider=document.querySelector('.raise-slider input[type=range]');if(slider)slider.value=raiseValue;}
  const viewport=()=>document.documentElement.style.setProperty('--play-height',Math.round(window.visualViewport?.height||innerHeight)+'px');
  viewport();window.addEventListener('resize',viewport);window.visualViewport?.addEventListener('resize',viewport);
  window.RiverTable={update,layout,render,clock,event,open,openAvatar,openPeekSettings,savePeekSettings,setTab,targetChanged,raiseTo,raiseInput,feedback,
    requestPeek:()=>cmd('peekRequest',{target:Number(el('socialTarget').value),tip:Number(el('peekTip').value),handNumber:state()?.handNumber}),
    kick:()=>cmd('kick',{target:Number(el('socialTarget').value)}),setMode:mode=>cmd('deckMode',{mode}),setBlinds:mode=>cmd('blindMode',{mode}),vote:twice=>cmd('runoutVote',{twice,handNumber:state()?.handNumber}),
    stop:()=>{playing=false;data=null;activePeek='';replyPending='';hideTurnNotice();document.body.classList.remove('in-game');el('playWorkspace').classList.remove('is-playing');el('actionPanel').innerHTML='';for(const id of ['socialDialog','avatarDialog','peekConsentDialog','peekSettingsDialog'])el(id).close();window.scrollTo({top:0});}
  };
  avatarUI();
})();
