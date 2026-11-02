'use strict';

const STORAGE_KEY = 'warikan.v1';
const MAX_AMOUNT = 100_000_000;

// ---------- 状態 ----------

let data = load();

function emptyData() {
  return { version: 1, groups: [] };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyData();
    return normalize(JSON.parse(raw));
  } catch (e) {
    console.error(e);
    return emptyData();
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.error(e);
    toast('保存に失敗しました');
  }
}

// 読み込んだデータを検証・整形する。不正なら例外を投げる
function normalize(obj) {
  if (!obj || !Array.isArray(obj.groups)) throw new Error('形式が正しくありません');
  const str = (v) => (typeof v === 'string' ? v : String(v ?? ''));
  return {
    version: 1,
    groups: obj.groups.map((g) => {
      if (!g || !Array.isArray(g.members) || !Array.isArray(g.expenses)) {
        throw new Error('グループの形式が正しくありません');
      }
      const members = g.members.map((m) => ({ id: str(m.id), name: str(m.name) }));
      const ids = new Set(members.map((m) => m.id));
      const expenses = g.expenses.map((e) => {
        const amount = Number(e.amount);
        const participantIds = Array.isArray(e.participantIds) ? e.participantIds.map(str) : [];
        if (!Number.isInteger(amount) || amount <= 0 || !ids.has(str(e.payerId)) ||
            participantIds.length === 0 || !participantIds.every((id) => ids.has(id))) {
          throw new Error('支出の形式が正しくありません');
        }
        return {
          id: str(e.id),
          title: str(e.title),
          amount,
          payerId: str(e.payerId),
          participantIds,
          createdAt: Number(e.createdAt) || Date.now(),
        };
      });
      return {
        id: str(g.id),
        name: str(g.name),
        createdAt: Number(g.createdAt) || Date.now(),
        members,
        expenses,
      };
    }),
  };
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---------- 計算 ----------

// 金額を対象者で割る。端数は「払った人」が対象に含まれていればその人が負担、
// そうでなければメンバー順で先頭から 1 円ずつ負担する。合計は必ず amount に一致する。
function splitAmount(amount, participantIds, payerId, memberOrder) {
  const ordered = memberOrder.filter((id) => participantIds.includes(id));
  const n = ordered.length;
  const base = Math.floor(amount / n);
  let rem = amount - base * n;
  const shares = new Map(ordered.map((id) => [id, base]));
  if (rem > 0 && shares.has(payerId)) {
    shares.set(payerId, base + rem);
    rem = 0;
  }
  for (const id of ordered) {
    if (rem === 0) break;
    shares.set(id, shares.get(id) + 1);
    rem--;
  }
  return shares;
}

// メンバーごとの { paid, owed, balance }。balance > 0 は受け取る側
function computeBalances(group) {
  const order = group.members.map((m) => m.id);
  const result = new Map(order.map((id) => [id, { paid: 0, owed: 0, balance: 0 }]));
  for (const e of group.expenses) {
    result.get(e.payerId).paid += e.amount;
    for (const [id, share] of splitAmount(e.amount, e.participantIds, e.payerId, order)) {
      result.get(id).owed += share;
    }
  }
  for (const r of result.values()) r.balance = r.paid - r.owed;
  return result;
}

// 送金回数が少なくなる精算リスト [{ from, to, amount }]
function computeSettlements(group) {
  const balances = computeBalances(group);
  const creditors = [];
  const debtors = [];
  for (const [id, { balance }] of balances) {
    if (balance > 0) creditors.push({ id, amt: balance });
    else if (balance < 0) debtors.push({ id, amt: -balance });
  }
  const transfers = [];

  // 1. 金額がぴったり一致するペアは 1 回の送金で済むので先に組む
  for (const d of debtors) {
    const c = creditors.find((c) => c.amt > 0 && c.amt === d.amt);
    if (c) {
      transfers.push({ from: d.id, to: c.id, amount: d.amt });
      c.amt = 0;
      d.amt = 0;
    }
  }

  // 2. 残りは「最大の債務者 → 最大の債権者」の貪欲法
  const cs = creditors.filter((c) => c.amt > 0).sort((a, b) => b.amt - a.amt);
  const ds = debtors.filter((d) => d.amt > 0).sort((a, b) => b.amt - a.amt);
  let i = 0;
  let j = 0;
  while (i < ds.length && j < cs.length) {
    const amount = Math.min(ds[i].amt, cs[j].amt);
    transfers.push({ from: ds[i].id, to: cs[j].id, amount });
    ds[i].amt -= amount;
    cs[j].amt -= amount;
    if (ds[i].amt === 0) i++;
    if (cs[j].amt === 0) j++;
  }
  return transfers;
}

// ---------- ユーティリティ ----------

const $ = (sel) => document.querySelector(sel);
const yen = (n) => '¥' + n.toLocaleString('ja-JP');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// 全角数字・カンマ・円記号を許容して整数に変換。不正なら NaN
function parseAmount(text) {
  const s = String(text)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[,，\s円¥￥]/g, '');
  return /^\d+$/.test(s) ? Number(s) : NaN;
}


let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
}

function openDialog(dialog) {
  dialog.returnValue = '';
  dialog.showModal();
}

// × ボタンは送信ボタンにしない(Enter キーで先頭の送信ボタン=閉じるが押されるのを防ぐ)
for (const btn of document.querySelectorAll('.close-btn')) {
  btn.addEventListener('click', () => btn.closest('dialog').close('cancel'));
}

// ---------- ルーティング ----------
// #/                     グループ一覧
// #/g/<groupId>/<tab>    グループ詳細(tab: expenses | settle | members)

let lastGroupId = null;

function route() {
  const m = location.hash.match(/^#\/g\/([^/]+)(?:\/(\w+))?/);
  if (!m) return { group: null, tab: null };
  const group = data.groups.find((g) => g.id === m[1]) || null;
  const tab = ['expenses', 'settle', 'members'].includes(m[2]) ? m[2] : 'expenses';
  if (group?.id !== lastGroupId) pieSelected = null; // 別グループに移ったら選択を解除
  lastGroupId = group?.id ?? null;
  return { group, tab };
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

window.addEventListener('hashchange', render);

// ---------- 描画 ----------

function render() {
  const { group, tab } = route();
  const main = $('#main');

  $('#menuBtn').hidden = !group;
  if (!group) {
    $('#title').textContent = '割り勘';
    $('#backBtn').hidden = true;
    $('#tabbar').hidden = true;
    document.body.classList.add('no-tabbar');
    $('#fab').hidden = false;
    $('#fab').setAttribute('aria-label', 'グループを作成');
    main.innerHTML = renderHome();
    return;
  }

  $('#title').textContent = group.name;
  $('#backBtn').hidden = false;
  $('#tabbar').hidden = false;
  document.body.classList.remove('no-tabbar');
  for (const t of document.querySelectorAll('.tab')) {
    t.classList.toggle('active', t.dataset.tab === tab);
  }
  $('#fab').hidden = tab !== 'expenses';
  $('#fab').setAttribute('aria-label', '支出を記録');

  if (tab === 'expenses') main.innerHTML = renderExpenses(group);
  else if (tab === 'settle') main.innerHTML = renderSettle(group);
  else main.innerHTML = renderMembers(group);
}

function renderHome() {
  if (data.groups.length === 0) {
    return `<div class="empty">グループがありません。<br>右下の「+」から作成しましょう。</div>`;
  }
  const items = [...data.groups]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((g) => {
      const total = g.expenses.reduce((s, e) => s + e.amount, 0);
      return `<li class="tap" data-open-group="${esc(g.id)}">
        <div class="grow">
          <div class="main-text">${esc(g.name)}</div>
          <div class="sub-text">${g.members.length}人・支出${g.expenses.length}件</div>
        </div>
        <span class="amount">${yen(total)}</span>
        <span class="chev">›</span>
      </li>`;
    })
    .join('');
  return `<p class="section-title">グループ</p><ul class="list">${items}</ul>`;
}

function memberName(group, id) {
  return group.members.find((m) => m.id === id)?.name ?? '(不明)';
}

// 円グラフでタップ中のメンバー(null なら合計を表示)
let pieSelected = null;
const PIE_SLOTS = 8; // 色は --s1〜--s8。9人目以降は「その他」にまとめる

// 誰がいくら払ったかのドーナツグラフ。色はメンバーの並び順で固定(金額順では変えない)
function renderPayerChart(group, total) {
  const balances = computeBalances(group);
  let slices = group.members.slice(0, PIE_SLOTS).map((m, i) => ({
    key: m.id, name: m.name, paid: balances.get(m.id).paid, color: `var(--s${i + 1})`,
  }));
  const rest = group.members.slice(PIE_SLOTS);
  if (rest.length) {
    slices.push({
      key: 'other', name: `その他${rest.length}人`, color: 'var(--s-other)',
      paid: rest.reduce((s, m) => s + balances.get(m.id).paid, 0),
    });
  }
  // % は最大剰余法で丸めて、合計が必ず 100% になるようにする
  const raw = slices.map((s) => (s.paid / total) * 100);
  const pcts = raw.map(Math.floor);
  let left = 100 - pcts.reduce((a, b) => a + b, 0);
  raw.map((v, i) => [v - pcts[i], i]).sort((a, b) => b[0] - a[0])
    .forEach(([, i]) => { if (left > 0) { pcts[i]++; left--; } });
  slices.forEach((s, i) => { s.pct = pcts[i]; });

  if (!slices.some((s) => s.key === pieSelected)) pieSelected = null;

  // 円周に沿って stroke-dasharray で各区間を描く。区間の間に 2px 相当のすき間をあける
  const r = 48;
  const C = 2 * Math.PI * r;
  const paidSlices = slices.filter((s) => s.paid > 0);
  const gap = paidSlices.length > 1 ? 1.6 : 0;
  let offset = 0;
  const arcs = paidSlices.map((s) => {
    const len = (s.paid / total) * C;
    const draw = Math.max(len - gap, 0.6);
    const dim = pieSelected && pieSelected !== s.key ? ' dim' : '';
    const arc = `<circle class="pie-seg${dim}" data-pie="${esc(s.key)}" cx="60" cy="60" r="${r}"
      stroke="${s.color}" stroke-dasharray="${draw} ${C - draw}" stroke-dashoffset="${-offset}"></circle>`;
    offset += len;
    return arc;
  }).join('');

  const sel = slices.find((s) => s.key === pieSelected);
  const center = sel
    ? `<div class="pie-label">${esc(sel.name)}</div><div class="pie-value">${yen(sel.paid)}</div><div class="pie-label">${sel.pct}%</div>`
    : `<div class="pie-label">合計</div><div class="pie-value">${yen(total)}</div>`;

  const legend = [...slices]
    .sort((a, b) => b.paid - a.paid)
    .map((s) => `<li class="tap${s.paid ? '' : ' zero'}${s.key === pieSelected ? ' selected' : ''}" data-pie="${esc(s.key)}">
        <span class="swatch" style="background:${s.color}"></span>
        <span class="grow main-text">${esc(s.name)}</span>
        <span class="sub-text">${s.pct}%</span>
        <span class="amount">${yen(s.paid)}</span>
      </li>`)
    .join('');

  const label = paidSlices.map((s) => `${s.name} ${yen(s.paid)}`).join('、');
  return `<div class="pie-card">
      <p class="section-title">誰がどれだけ払った?</p>
      <div class="pie-wrap">
        <svg viewBox="0 0 120 120" class="pie" role="img" aria-label="支払額の内訳: ${esc(label)}">
          <g transform="rotate(-90 60 60)">${arcs}</g>
        </svg>
        <div class="pie-center">${center}</div>
      </div>
      <ul class="list pie-legend">${legend}</ul>
    </div>`;
}

function renderExpenses(group) {
  const total = group.expenses.reduce((s, e) => s + e.amount, 0);
  let html = total > 0
    ? renderPayerChart(group, total)
    : `<div class="summary"><div class="sub-text">合計</div><div class="big">${yen(total)}</div></div>`;
  if (group.members.length === 0) {
    return html + `<div class="empty">まずは「メンバー」タブで<br>メンバーを追加しましょう。</div>`;
  }
  if (group.expenses.length === 0) {
    return html + `<div class="empty">支出がありません。<br>右下の「+」から記録しましょう。</div>`;
  }
  const items = [...group.expenses]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((e) => {
      const who = e.participantIds.length === group.members.length
        ? '全員'
        : e.participantIds.map((id) => memberName(group, id)).join('・');
      return `<li>
        <div class="grow">
          <div class="main-text">${esc(e.title || '(内容なし)')}</div>
          <div class="sub-text">${esc(memberName(group, e.payerId))}が支払い → ${esc(who)}</div>
        </div>
        <span class="amount">${yen(e.amount)}</span>
        <button class="del-btn" data-del-expense="${esc(e.id)}" aria-label="削除">削除</button>
      </li>`;
    })
    .join('');
  return html + `<p class="section-title">支出</p><ul class="list">${items}</ul>`;
}

function renderSettle(group) {
  if (group.expenses.length === 0) {
    return `<div class="empty">支出を記録すると<br>精算結果が表示されます。</div>`;
  }
  const transfers = computeSettlements(group);
  const balances = computeBalances(group);

  const tItems = transfers.length === 0
    ? `<li><div class="grow sub-text">精算の必要はありません 🎉</div></li>`
    : transfers.map((t) => `<li class="transfer">
        <div class="grow main-text">${esc(memberName(group, t.from))} <span class="arrow">→</span> ${esc(memberName(group, t.to))}</div>
        <span class="amount">${yen(t.amount)}</span>
      </li>`).join('');

  const bItems = group.members.map((m) => {
    const b = balances.get(m.id);
    const cls = b.balance > 0 ? 'plus' : b.balance < 0 ? 'minus' : '';
    const sign = b.balance > 0 ? '+' : b.balance < 0 ? '−' : '';
    return `<li>
      <div class="grow">
        <div class="main-text">${esc(m.name)}</div>
        <div class="sub-text">支払 ${yen(b.paid)}・負担 ${yen(b.owed)}</div>
      </div>
      <span class="amount ${cls}">${sign}${yen(Math.abs(b.balance))}</span>
    </li>`;
  }).join('');

  return `<p class="section-title">送金(${transfers.length}回)</p><ul class="list">${tItems}</ul>
    <p class="section-title">メンバー別の収支(+ は受け取り)</p><ul class="list">${bItems}</ul>`;
}

function renderMembers(group) {
  const adder = `<form id="inlineMemberForm" class="adder">
      <input name="name" maxlength="20" placeholder="メンバー名" autocomplete="off" enterkeyhint="done" aria-label="メンバー名">
      <button class="adder-btn">追加</button>
    </form>`;
  if (group.members.length === 0) {
    return adder + `<div class="empty">メンバーがいません。<br>名前を入力して追加しましょう。</div>`;
  }
  const items = group.members.map((m) => {
    const n = group.expenses.filter((e) => e.payerId === m.id || e.participantIds.includes(m.id)).length;
    return `<li class="tap" data-edit-member="${esc(m.id)}">
      <div class="grow main-text">${esc(m.name)}</div>
      <span class="sub-text">${n ? `支出${n}件` : ''}</span>
      <span class="chev">›</span>
    </li>`;
  }).join('');
  return adder + `<p class="section-title">メンバー(${group.members.length}人)・タップで編集</p><ul class="list">${items}</ul>`;
}

// ---------- 操作 ----------

$('#main').addEventListener('click', (ev) => {
  const { group } = route();
  const openG = ev.target.closest('[data-open-group]');
  if (openG) return go(`#/g/${openG.dataset.openGroup}/expenses`);

  const delE = ev.target.closest('[data-del-expense]');
  if (delE && group) {
    const e = group.expenses.find((x) => x.id === delE.dataset.delExpense);
    if (e && confirm(`「${e.title || '(内容なし)'} ${yen(e.amount)}」を削除しますか?`)) {
      group.expenses = group.expenses.filter((x) => x !== e);
      save();
      render();
    }
    return;
  }

  const pie = ev.target.closest('[data-pie]');
  if (pie) {
    pieSelected = pieSelected === pie.dataset.pie ? null : pie.dataset.pie;
    render();
    return;
  }

  const editM = ev.target.closest('[data-edit-member]');
  if (editM && group) openMemberDialog(group, editM.dataset.editMember);
});

// メンバータブの追加フォーム(描画のたびに作り直されるので委譲で受ける)
$('#main').addEventListener('submit', (ev) => {
  if (ev.target.id !== 'inlineMemberForm') return;
  ev.preventDefault();
  const { group } = route();
  const name = ev.target.name.value.trim();
  if (!group || !name) return;
  if (group.members.some((m) => m.name === name)) return toast('同じ名前のメンバーがいます');
  group.members.push({ id: uid(), name });
  save();
  render();
  $('#inlineMemberForm').name.focus(); // 続けて追加しやすいように
});

$('#backBtn').addEventListener('click', () => go('#/'));

for (const t of document.querySelectorAll('.tab')) {
  t.addEventListener('click', () => {
    const { group } = route();
    if (group) go(`#/g/${group.id}/${t.dataset.tab}`);
  });
}

$('#fab').addEventListener('click', () => {
  const { group, tab } = route();
  if (!group) {
    $('#groupForm').reset();
    draftMembers = [];
    renderDraftMembers();
    openDialog($('#groupDialog'));
  } else if (group.members.length === 0) {
    toast('先にメンバーを追加してください');
    go(`#/g/${group.id}/members`);
    $('#inlineMemberForm')?.name.focus();
  } else if (tab === 'expenses') {
    openExpenseDialog(group);
  }
});

// グループ作成(メンバーは入力欄+「追加」でチップとして並べる)
let draftMembers = [];

function renderDraftMembers() {
  $('#draftMembers').innerHTML = draftMembers.map((name, i) =>
    `<span class="member-chip">${esc(name)}<button type="button" data-remove-draft="${i}" aria-label="${esc(name)}を外す">×</button></span>`
  ).join('');
  $('#draftMemberAdd').disabled = !$('#draftMemberInput').value.trim();
}

// 入力中の名前をチップに追加する。追加できたら true
function addDraftMember() {
  const input = $('#draftMemberInput');
  const name = input.value.trim();
  if (!name) return false;
  if (draftMembers.includes(name)) {
    toast('同じ名前のメンバーがいます');
    return false;
  }
  draftMembers.push(name);
  input.value = '';
  renderDraftMembers();
  return true;
}

$('#draftMemberInput').addEventListener('input', renderDraftMembers);
$('#draftMemberInput').addEventListener('keydown', (ev) => {
  // Enter はフォーム送信ではなくメンバー追加にする(日本語変換の確定 Enter は除外)
  if (ev.key !== 'Enter' || ev.isComposing) return;
  ev.preventDefault();
  addDraftMember();
});
$('#draftMemberAdd').addEventListener('click', () => {
  addDraftMember();
  $('#draftMemberInput').focus();
});
$('#draftMembers').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-remove-draft]');
  if (!btn) return;
  draftMembers.splice(Number(btn.dataset.removeDraft), 1);
  renderDraftMembers();
});

$('#groupForm').addEventListener('submit', (ev) => {
  if (ev.submitter?.value !== 'ok') return;
  const name = ev.target.name.value.trim();
  if (!name) { ev.preventDefault(); return; }
  // 入力欄に残っている名前は「追加」を押し忘れたものとして取り込む
  addDraftMember();
  const group = {
    id: uid(),
    name,
    createdAt: Date.now(),
    members: draftMembers.map((n) => ({ id: uid(), name: n })),
    expenses: [],
  };
  data.groups.push(group);
  save();
  go(`#/g/${group.id}/${group.members.length ? 'expenses' : 'members'}`);
});

// メンバー編集(名前の変更・削除)
let editingMemberId = null;

function openMemberDialog(group, memberId) {
  const m = group.members.find((x) => x.id === memberId);
  if (!m) return;
  editingMemberId = memberId;
  $('#memberForm').name.value = m.name;
  openDialog($('#memberDialog'));
}

$('#memberForm').addEventListener('submit', (ev) => {
  const action = ev.submitter?.value;
  if (action !== 'ok' && action !== 'delete') return;
  const { group } = route();
  const m = group?.members.find((x) => x.id === editingMemberId);
  if (!m) return;

  if (action === 'delete') {
    if (!deleteMember(group, m)) ev.preventDefault();
    return;
  }
  const name = ev.target.name.value.trim();
  if (!name) { ev.preventDefault(); return; }
  if (group.members.some((x) => x !== m && x.name === name)) {
    ev.preventDefault();
    toast('同じ名前のメンバーがいます');
    return;
  }
  m.name = name;
  save();
  render();
});

// メンバーを削除する。削除したら true
// 払った人になっている支出がある場合は削除できない。
// 対象者としてだけ含まれる支出からは外し、残りの人で割り直す(対象者が 0 人になる支出は削除)
function deleteMember(group, m) {
  const paid = group.expenses.filter((e) => e.payerId === m.id);
  if (paid.length) {
    alert(`${m.name}さんが払った支出が${paid.length}件あるため削除できません。\n先にその支出を削除してください。`);
    return false;
  }
  const involved = group.expenses.filter((e) => e.participantIds.includes(m.id));
  const orphaned = involved.filter((e) => e.participantIds.length === 1);
  let msg = `${m.name}さんを削除しますか?`;
  if (involved.length) {
    msg += `\n\n対象になっている支出${involved.length}件から外し、残りのメンバーで割り直します。`;
    if (orphaned.length) msg += `\n(${m.name}さんだけが対象の支出${orphaned.length}件は削除されます)`;
  }
  if (!confirm(msg)) return false;

  group.expenses = group.expenses
    .filter((e) => !orphaned.includes(e))
    .map((e) => ({ ...e, participantIds: e.participantIds.filter((id) => id !== m.id) }));
  group.members = group.members.filter((x) => x !== m);
  save();
  render();
  toast(`${m.name}さんを削除しました`);
  return true;
}

// 支出記録
const expenseState = { payerId: null, participants: new Set() };

function openExpenseDialog(group) {
  $('#expenseForm').reset();
  expenseState.payerId = group.members[0].id;
  expenseState.participants = new Set(group.members.map((m) => m.id));
  renderExpenseChoices(group);
  openDialog($('#expenseDialog'));
}

function renderExpenseChoices(group) {
  $('#payerChoices').innerHTML = group.members.map((m) =>
    `<button type="button" class="chip ${m.id === expenseState.payerId ? 'on' : ''}" data-payer="${esc(m.id)}">${esc(m.name)}</button>`
  ).join('');
  $('#participantChoices').innerHTML = group.members.map((m) =>
    `<button type="button" class="chip ${expenseState.participants.has(m.id) ? 'on' : ''}" data-participant="${esc(m.id)}">${esc(m.name)}</button>`
  ).join('');
  const all = expenseState.participants.size === group.members.length;
  $('#toggleAllBtn').textContent = all ? '全解除' : '全員';
  updateSplitPreview(group);
}

function updateSplitPreview(group) {
  const amount = parseAmount($('#expenseForm').amount.value);
  const ids = [...expenseState.participants];
  const el = $('#splitPreview');
  if (!ids.length) { el.textContent = '対象メンバーを選んでください'; return; }
  if (!(amount > 0)) { el.textContent = `${ids.length}人で割り勘`; return; }
  const base = Math.floor(amount / ids.length);
  const rem = amount % ids.length;
  const remWho = expenseState.participants.has(expenseState.payerId) ? '払った人' : '先頭の人';
  el.textContent = `${ids.length}人で割ると 1人 ${yen(base)}` + (rem ? `(端数 ${rem}円は${remWho}が負担)` : '');
}

$('#expenseDialog').addEventListener('click', (ev) => {
  const { group } = route();
  if (!group) return;
  const payer = ev.target.closest('[data-payer]');
  const part = ev.target.closest('[data-participant]');
  if (payer) {
    expenseState.payerId = payer.dataset.payer;
  } else if (part) {
    const id = part.dataset.participant;
    if (expenseState.participants.has(id)) expenseState.participants.delete(id);
    else expenseState.participants.add(id);
  } else if (ev.target.id === 'toggleAllBtn') {
    expenseState.participants = expenseState.participants.size === group.members.length
      ? new Set()
      : new Set(group.members.map((m) => m.id));
  } else {
    return;
  }
  renderExpenseChoices(group);
});

$('#expenseForm').amount.addEventListener('input', () => {
  const { group } = route();
  if (group) updateSplitPreview(group);
});

$('#expenseForm').addEventListener('submit', (ev) => {
  if (ev.submitter?.value !== 'ok') return;
  const { group } = route();
  const form = ev.target;
  const amount = parseAmount(form.amount.value);
  const fail = (msg) => { ev.preventDefault(); toast(msg); };
  if (!group) return fail('グループが見つかりません');
  if (!(amount > 0) || amount > MAX_AMOUNT) return fail('金額を正しく入力してください');
  if (!expenseState.participants.size) return fail('対象メンバーを選んでください');
  group.expenses.push({
    id: uid(),
    title: form.title.value.trim(),
    amount,
    payerId: expenseState.payerId,
    participantIds: group.members.map((m) => m.id).filter((id) => expenseState.participants.has(id)),
    createdAt: Date.now(),
  });
  save();
  render();
  toast(`${yen(amount)} を記録しました`);
});

// メニュー(グループ画面のみ)
$('#menuBtn').addEventListener('click', () => openDialog($('#menuDialog')));

$('#menuDialog').addEventListener('close', () => {
  if ($('#menuDialog').returnValue === 'deleteGroup') deleteCurrentGroup();
});

function deleteCurrentGroup() {
  const { group } = route();
  if (!group) return;
  if (!confirm(`グループ「${group.name}」を削除しますか?\nこの操作は取り消せません。`)) return;
  data.groups = data.groups.filter((g) => g !== group);
  save();
  go('#/');
  toast('削除しました');
}

// ---------- 起動 ----------

render();

if ('serviceWorker' in navigator) {
  // 新しい Service Worker に切り替わったら一度だけ再読み込みして最新版を表示する
  // (初回インストール時は controller が無いので再読み込みしない)
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        // ホーム画面アプリは開きっぱなしになりがちなので、前面に戻るたびに更新を確認する
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update().catch(() => {});
        });
      })
      .catch((e) => console.error(e));
  });
}
