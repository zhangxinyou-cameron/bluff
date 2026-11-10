(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.RunoutTimeline=api;})(globalThis,function(){
  function build(fromCards,boardCount,interval){
    const counts=[3,4,5].filter(n=>n>fromCards),steps=[];let at=0;
    for(let board=0;board<boardCount;board++)for(const count of counts){at+=interval;steps.push({at,board,count});}
    return{steps,duration:at+interval,interval,fromCards,boardCount};
  }
  function frame(timeline,elapsed){
    const counts=Array(timeline.boardCount).fill(timeline.fromCards);let board=0;
    for(const step of timeline.steps)if(elapsed>=step.at){counts[step.board]=step.count;board=step.board;}
    return{counts,board,complete:elapsed>=timeline.duration};
  }
  return{build,frame};
});
