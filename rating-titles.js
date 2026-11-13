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

function combinationTitle(values) {
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
    return pairs[left + ' ' + right][first > second ? 0 : second > first ? 1 : 2];
  }
  if (luck === 5 && !strengths.some(([, score]) => score === 5)) return '好运连连';
  if (strengths.length === 1) {
    const [[style, score]] = strengths;
    return specialists[style][score - 4];
  }
  if (luck === null || styles.some(([, score]) => score === null)) return null;
  const average = styles.reduce((sum, [, score]) => sum + score, 0) / styles.length;
  if (luck === 4) return '顺风牌手';
  if (luck <= 2 && average >= 2.6) return '逆风磨砺';
  return average >= 2.6 ? '均衡牌手' : '磨牌新秀';
}

module.exports = { combinationTitle };
