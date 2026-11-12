const E=require('./public/poker-engine');
const packs=require('./public/table-packs.json');
const Avatars=require('./public/avatars');
const safePacks={phrases:packs.phrases.map(p=>({...p,audio:typeof p.audio==='string'&&/^\/audio\/packs\/[\w\-/]+\.(wav|mp3|ogg)$/.test(p.audio)?p.audio:null})),gifts:packs.gifts};
const fail=message=>({ok:false,message});
module.exports=function install(RoomManager){
  Object.assign(RoomManager.prototype,{
    extraSnapshot(room,viewer){
      const g=room.game;
      return{packs:safePacks,peekRequests:(g?.peekRequests||[]).filter(r=>r.from===viewer||r.to===viewer),runoutVote:g?.runoutVote||null,
        roster:[...room.people.values()].map(p=>({id:p.id,name:p.name,avatar:p.avatar,peekThreshold:p.peekThreshold??null,connected:p.connected,kicked:!!p.kicked,retired:p.retired}))};
    },
    extraCommand(room,person,data){
      const g=room.game,me=g?.players.find(p=>p.id===person.id);
      if(room.leagueMatch?.mode==='team'&&['peekThreshold','peekRequest','peekReply'].includes(data.type))return fail('计分团队场不开放定向看牌');
      if(room.leagueMatch&&g&&['deckMode','blindMode'].includes(data.type))return fail('联赛比赛开局后锁定牌制和盲注');
      if(data.type==='peekThreshold'){
        if(data.threshold!==null&&(!Number.isSafeInteger(data.threshold)||data.threshold<0))return fail('门槛须为非负整数，或关闭自动同意');
        person.peekThreshold=data.threshold;return{ok:true,message:data.threshold===null?'已改为手动确认看牌申请':`看牌门槛已公开为 ${data.threshold} 筹码，后续达标申请自动同意`};
      }
      if(data.type==='avatar'){
        if(!Avatars.valid(data.avatar))return fail('请选择有效的头像');
        if(person.uid)this.accounts.update(person.uid,{avatar:data.avatar});
        person.avatar=data.avatar;if(me)me.avatar=data.avatar;return{ok:true,message:'头像已更新'};
      }
      if(data.type==='closeRoom'){
        if(person.id!==0)return fail('只有房主可以关闭房间');this.closeRoom(room.code,'房主已关闭房间');return{ok:true};
      }
      if(data.type==='kick'){
        if(person.id!==0)return fail('只有房主可以踢出玩家');
        if(!Number.isSafeInteger(data.target)||data.target===0)return fail('不能踢出房主');
        const target=room.people.get(data.target),player=g?.players.find(p=>p.id===data.target);
        if(!target&&!player)return fail('玩家不存在');
        if(target?.kicked)return{ok:true,duplicate:true};
        if(target){
          target.kicked=true;target.retired=true;target.connected=false;target.ready=false;
          target.revokedTokenHash=target.tokenHash;this.rotateToken(target);
          target.rejoinToken=target.token;target.rejoinTokenHash=target.tokenHash;target.token=null;target.tokenHash=null;
        }
        const ws=this.connections.get(room.code)?.get(data.target);if(ws){ws.send(JSON.stringify({type:'kicked',fatal:true,message:'你已被房主移出房间，可手动重新加入',rejoinToken:target?.rejoinToken}));this.connections.get(room.code).delete(data.target);ws.close(4003,'Removed by host');}
        for(const request of g?.peekRequests||[])if(request.status==='pending'&&(request.from===data.target||request.to===data.target))request.status='expired';
        const before=g?.phase,from=g?.communityCards.length;if(player){player.connected=false;E.disconnect(g,data.target);}else delete room.aiSlots[data.target];
        this.event(room,'system',`${target?.name||player?.name} 已被房主移出房间`);
        if(g?.phase==='runout_vote'&&g.runoutVote.eligibleIds.includes(data.target))this.finishVote(room,false,'有争池玩家离桌，本手发一次牌');
        else if(g&&E.betting({phase:before})&&['hand_over','tournament_over'].includes(g.phase)){
          this.pace(room,g.showdownOccurred?'runout':null,from,this.timing.action);this.recordSettlement(room);
        }
        if(g?.phase==='hand_over')this.tryStart(room);
        return{ok:true};
      }
      if(data.type==='deckMode'){
        if(person.id!==0)return fail('只有房主可以切换牌制');
        if(!['auto','short','standard'].includes(data.mode))return fail('牌制无效');
        if(g&&!['hand_over','tournament_over'].includes(g.phase))return fail('请在本手结束后切换牌制');
        if(!g){this.updateWaitingRules(room,{...room.settings,deckMode:data.mode});return{ok:true};}
        room.settings.deckMode=data.mode;g.deckMode=data.mode;g.nextHandReady=[];g.revision++;
        this.event(room,'system',`房主选择${{auto:'自动人数牌制',short:'36张短牌',standard:'52张标准德扑'}[data.mode]}，下一手生效，请重新确认`);return{ok:true};
      }
      if(data.type==='blindMode'){
        if(person.id!==0)return fail('只有房主可以切换底注规则');
        if(!['auto','ante','position','standard'].includes(data.mode))return fail('底注规则无效');
        if(g&&g.phase!=='hand_over')return fail('请在本手结束后切换底注规则');
        if(!g){this.updateWaitingRules(room,{...room.settings,blindMode:data.mode});return{ok:true};}
        room.settings.blindMode=data.mode;g.blindMode=data.mode;g.nextHandReady=[];g.revision++;
        this.event(room,'system',`房主选择${{auto:'跟随牌制默认底注',ante:'全员底注＋庄家盲注',position:'庄家左手第一位1倍、第二位半倍盲注',standard:'标准位置制：SB半倍、BB1倍，翻前从BB后一位行动'}[data.mode]}，下一手生效，请重新确认`);return{ok:true};
      }
      if(data.type==='phrase'||data.type==='gift'){
        if(Date.now()-(person.socialAt||0)<1000)return fail('请稍候再发送互动');
        if(data.type==='phrase'){
          const phrase=safePacks.phrases.find(p=>p.id===data.phraseId);if(!phrase)return fail('语言包不存在');
          person.socialAt=Date.now();this.event(room,'phrase',phrase.text,{phraseId:phrase.id,name:person.name,seatId:person.id});return{ok:true};
        }
        const gift=safePacks.gifts.find(p=>p.id===data.giftId),target=room.people.get(data.target)||g?.players.find(p=>p.id===data.target);
        if(!gift||!target||data.target===person.id||target.kicked||target.disconnected)return fail('请选择有效的互动对象');
        person.socialAt=Date.now();this.event(room,'gift',`${person.name} 向 ${target.name} ${gift.label}`,{giftId:gift.id,from:person.id,to:data.target,name:person.name});return{ok:true};
      }
      if(data.type==='peekRequest'){
        if(!g||data.handNumber!==g.handNumber||!E.canRequestPeek(me)||g.phase==='tournament_over')return fail('只有本手已弃牌或无筹码观战的玩家可以申请看牌');
        const target=g.players.find(p=>p.id===data.target),tip=Number(data.tip||0);
        if(!target||target.id===person.id||target.isAI||target.disconnected||target.connected===false||target.holeCards.length!==2)return fail('请选择在线真人玩家');
        if(!Number.isSafeInteger(tip)||tip<0||tip>me.chips)return fail('小费须为不超过持有筹码的非负整数');
        if(g.peekRequests.some(r=>r.from===person.id&&r.to===target.id))return fail('本手已向此玩家申请过');
        if(g.peekRequests.length>=56)return fail('本手申请已满');
        const request={id:`${g.handNumber}-${person.id}-${target.id}`,from:person.id,to:target.id,tip,status:'pending',handNumber:g.handNumber,expiresAt:Date.now()+10000};
        const threshold=room.people.get(target.id)?.peekThreshold;
        if(threshold!=null&&tip>=threshold){
          const result=this.approvePeek(room,request,true);if(!result.ok)return result;
          g.peekRequests.push(request);return{ok:true,message:'小费达到公开门槛，已自动同意，仅你可见'};
        }
        g.peekRequests.push(request);
        return{ok:true,message:'看牌申请已发送，等待对方同意'};
      }
      if(data.type==='peekReply'){
        if(g?.phase==='tournament_over')return fail('整场已结算，看牌申请已结束');
        const request=g?.peekRequests.find(r=>r.id===data.peekId&&r.to===person.id&&r.handNumber===g.handNumber);
        if(request?.status==='pending'&&Date.now()>=request.expiresAt)request.status='expired';
        if(!request||request.status!=='pending')return fail('申请已处理或已过期');
        if(data.accept!==true){request.status='declined';return{ok:true};}
        return this.approvePeek(room,request,false);
      }
      if(data.type==='runoutVote'){
        const vote=g?.runoutVote;if(g?.phase!=='runout_vote'||data.handNumber!==g.handNumber||!vote.eligibleIds.includes(person.id))return fail('当前不能参与发牌协商');
        if(Date.now()>vote.expiresAt){this.finishVote(room,false,'协商超时，本手发一次牌');return fail('协商已超时');}
        if(data.twice!==true){this.finishVote(room,false,person.name+' 选择发一次牌');return{ok:true};}
        if(!vote.yesIds.includes(person.id))vote.yesIds.push(person.id);
        if(vote.eligibleIds.every(id=>vote.yesIds.includes(id)))this.finishVote(room,true,'所有争池玩家同意，发两次公共牌');
        return{ok:true};
      }
    },
    approvePeek(room,request,automatic){
      const g=room.game,payer=g.players.find(p=>p.id===request.from),owner=g.players.find(p=>p.id===request.to);
      if(!E.canRequestPeek(payer)||!owner||owner.connected===false||owner.disconnected||owner.holeCards.length!==2)return fail('申请者已不能看牌或目标玩家已离桌');
      const reserved=g.tips.filter(t=>t.from===payer.id&&!t.paid).reduce((s,t)=>s+t.amount,0);
      const incoming=g.tips.filter(t=>t.to===owner.id&&!t.paid).reduce((s,t)=>s+t.amount,0);
      if(payer.chips-reserved<request.tip)return fail('申请者可用筹码不足，小费未转账');
      if(!Number.isSafeInteger(owner.chips+incoming+request.tip))return fail('小费金额超出可记录范围');
      request.status='approved';request.automatic=automatic;(g.privateReveals[owner.id]||=([])).push(payer.id);
      if(request.tip>0)g.tips.push({from:payer.id,to:owner.id,amount:request.tip,paid:false});
      if(g.phase==='hand_over')this.payTips(room);
      return{ok:true,message:request.tip?'已定向亮牌，小费于本手结算后转账':'已仅向申请者亮牌'};
    },
    prepareVote(room){
      const vote=room.game.runoutVote;if(!vote||vote.expiresAt)return;
      this.stats?.lock(room);
      vote.expiresAt=Date.now()+(this.timing.vote??20000);
      vote.yesIds=vote.eligibleIds.filter(id=>room.game.players.find(p=>p.id===id)?.isAI);
      this.event(room,'system','下注已结束，等待所有争池玩家协商：发两次需全员同意，拒绝或超时则发一次');
      if(vote.eligibleIds.some(id=>room.game.players.find(p=>p.id===id)?.connected===false))this.finishVote(room,false,'有争池玩家离线，本手发一次牌');
      else if(vote.eligibleIds.every(id=>vote.yesIds.includes(id)))this.finishVote(room,true,'所有争池人机同意发两次');
    },
    finishVote(room,twice,reason){
      const from=room.game.communityCards.length;if(!E.resolveRunout(room.game,twice))return;
      this.event(room,'system',reason);this.pace(room,'runout',from,this.timing.runout);this.recordSettlement(room);
    },
    payTips(room){
      const g=room.game;
      for(const tip of g.tips||[]){
        if(tip.paid)continue;const from=g.players.find(p=>p.id===tip.from),to=g.players.find(p=>p.id===tip.to);
        if(from.chips<tip.amount||!Number.isSafeInteger(to.chips+tip.amount))throw new Error('tip accounting invalid');
        from.chips-=tip.amount;to.chips+=tip.amount;tip.paid=true;g.nextHandReady=g.nextHandReady.filter(id=>id!==from.id&&id!==to.id);
        if(!g.allowBuyIn){if(from.chips===0&&from.eliminatedHand==null){from.eliminatedHand=g.handNumber;from.eliminationStack=from.chipsBeforeHand;}if(to.chips>0){to.eliminatedHand=null;to.eliminationStack=null;}}
        this.event(room,'tip',`${from.name} 向 ${to.name} 支付看牌小费 ${tip.amount}`);
      }
    }
  });
};
