const path = require('node:path');
const { Accounts } = require('../accounts');
const { hiddenQuestion } = require('../access');

async function reset() {
  const number = process.argv[2];
  if (!/^[0-9]{1,128}$/.test(number || '')) throw new Error('用法：node tools/reset-account.js 数字账号');
  const accounts = new Accounts(path.join(__dirname, '..', 'data'));
  const password = await hiddenQuestion('新的数字密码：');
  const confirmation = await hiddenQuestion('再次输入新密码：');
  await accounts.resetPassword(number, password, confirmation);
  console.log('密码已重置，UID 和历史赛果仍可使用。');
}

reset().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
