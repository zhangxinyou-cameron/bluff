const specialists = {
  strategy: ['虚实试探', '偷鸡摸狗'],
  calculation: ['精打细算', '精算牌手'],
  courage: ['临阵敢打', '敢打敢拼'],
  attack: ['善做价值', '主动进攻'],
  stability: ['知进知退', '稳健派']
};

// Each pair lists its two leading styles, followed by the title for a tie.
const pairs = {
  'strategy calculation': ['以诈破局', '精算布局', '运筹帷幄'],
  'strategy courage': ['诱敌深入', '敢诈敢打', '虚实难辨'],
  'strategy attack': ['偷鸡有道', '攻势藏锋', '虚实并进'],
  'strategy stability': ['收放自如', '守中藏诈', '静待破局'],
  'calculation courage': ['算准敢押', '险中求胜', '胆大心细'],
  'calculation attack': ['精算加压', '价值榨取', '精算造池'],
  'calculation stability': ['冷静精算', '止损有方', '步步为营'],
  'courage attack': ['敢闯敢押', '主动强攻', '锋芒毕露'],
  'courage stability': ['敢打知退', '进退有据', '有勇有谋'],
  'attack stability': ['以攻带守', '稳中取利', '攻守兼备']
};

// Fixed reference points for comparing styles across different scoring curves.
const typical = { strategy: 2.1, calculation: 2.4, courage: 2.1, attack: 3, stability: 3 };
const singleStyle = {
  strategy: ['少诈多看', '择机施压'],
  calculation: ['凭牌感下注', '细看赔率'],
  courage: ['慎押弱牌', '迎压敢跟'],
  attack: ['小池试探', '择机取值'],
  stability: ['宽线接注', '见势收手']
};
const commonPairs = {
  'strategy calculation': ['借势试探', '算价出招'],
  'strategy courage': ['轻注藏招', '弱牌施压'],
  'strategy attack': ['虚招探路', '真假两路'],
  'strategy stability': ['试探知退', '守线藏招'],
  'calculation courage': ['算着跟注', '算准敢跟'],
  'calculation attack': ['算价取值', '算准做池'],
  'calculation stability': ['盯价控损', '稳算止损'],
  'courage attack': ['重牌敢压', '弱牌敢打'],
  'courage stability': ['能跟能收', '进退有尺']
};

function practicalTitle(values, estimates) {
  const styles = Object.entries(typical).flatMap(([key, reference]) => {
    const value = values[key];
    if (!Number.isFinite(value?.score)) return [];
    const estimate = estimates?.[key] ?? value.score;
    // A dimension with fewer opportunities gets less influence over the style label.
    const relative = (estimate - reference) * Math.min(1, value.samples / 12);
    return [{ key, estimate, relative, tier: value.score }];
  });
  const luck = values.luck?.score;
  if (!styles.length) {
    if (!Number.isFinite(luck)) return null;
    if (luck >= 5) return '好运连连';
    return luck <= 2 ? '逆风摸牌' : luck >= 4 ? '顺风摸牌' : '牌运平稳';
  }
  const levels = styles.map(style => style.estimate);
  if (styles.length === 5 && Math.min(...levels) >= 2.25 && Math.max(...levels) - Math.min(...levels) <= 0.18) return '五路兼顾';
  const [lead, next] = [...styles].sort((a, b) => b.relative - a.relative);
  if (!next || next.relative < -0.45) {
    if (lead.tier >= 4 && values[lead.key].samples >= 12) return specialists[lead.key][Number(lead.tier >= 5)];
    return singleStyle[lead.key][Number(lead.relative >= 0)];
  }

  const [first, second] = styles.filter(style => style === lead || style === next);
  const pair = first.key + ' ' + second.key;
  if (pair === 'attack stability') {
    const calculation = styles.find(style => style.key === 'calculation');
    if (first.estimate >= 3.5 && calculation?.estimate >= 2.5) return '算准做池';
    if (lead.key === 'attack' && lead.relative - next.relative > 0.22) return '择机取值';
    if (first.estimate >= 3.5) return '稳注取值';
    return calculation?.estimate >= 1.7 ? '小池收放' : '控池守线';
  }
  if (pair === 'courage attack') return commonPairs[pair][Number(first.tier >= 3)];
  if (pair === 'calculation attack') return commonPairs[pair][Number(first.estimate >= 2.5 && second.estimate >= 3.5)];
  return commonPairs[pair][Number(lead === second)];
}

function combinationTitle(values, estimates) {
  const luck = values.luck.samples >= 12 ? values.luck.score : null;
  const styles = Object.keys(specialists).map(key => [key, values[key].samples >= 12 ? values[key].score : null]);
  const strengths = styles.filter(([, score]) => score >= 4);
  if (strengths.length >= 3) {
    if (luck === 5) return '天时地利';
    if (luck !== null && luck <= 2) return '逆风掌局';
    if (strengths.length === styles.length) return '全能牌手';
    return '多面高手';
  }
  if (strengths.length === 2) {
    const [[left, first], [right, second]] = strengths;
    const edge = (estimates?.[left] ?? first) - (estimates?.[right] ?? second);
    if (left === 'attack' && right === 'stability' && first === 4 && second === 4 && estimates?.calculation >= 2.6) return '攻守有算';
    const lead = first - second || (Math.abs(edge) > 0.22 ? edge : 0);
    return pairs[left + ' ' + right][lead === 0 ? 2 : Number(lead < 0)];
  }
  if (strengths.length === 1 && strengths[0][1] === 5) {
    const [[style, score]] = strengths;
    return specialists[style][score - 4];
  }
  return practicalTitle(values, estimates);
}

module.exports = { combinationTitle, practicalTitle };
