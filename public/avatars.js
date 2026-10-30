/* Shared, local-only avatar catalogue. No remote images or user HTML. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.RiverAvatars=api;})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const items=Object.freeze([
    {id:'default',name:'经典黑桃',emoji:'♠'},
    {id:'fox',name:'小狐狸',emoji:'🦊'},
    {id:'panda',name:'熊猫',emoji:'🐼'},
    {id:'cat',name:'猫咪',emoji:'🐱'},
    {id:'lion',name:'狮子',emoji:'🦁'},
    {id:'owl',name:'猫头鹰',emoji:'🦉'},
    {id:'rabbit',name:'兔子',emoji:'🐰'},
    {id:'robot',name:'机器人',emoji:'🤖'}
  ].map(Object.freeze));
  const valid=id=>items.some(item=>item.id===id),get=id=>items.find(item=>item.id===id)||items[0];
  const read=()=>{try{return get(localStorage.getItem('river_avatar')).id;}catch(_){return'default';}};
  const save=id=>{try{localStorage.setItem('river_avatar',get(id).id);}catch(_){}};
  const markup=id=>{const a=get(id);return `<span class="player-avatar" data-avatar="${a.id}" role="img" aria-label="${a.name}">${a.emoji}</span>`;};
  return{items,get,valid,read,save,markup};
});
