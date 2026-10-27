// Fills the helpdesk with realistic Trick or Commit tickets spread over two weeks,
// at every AutoFix stage, so the dashboard has something to show.
// Writes straight to the database; nothing is sent to AutoFix.
//   npm run seed:demo            (refuses if tickets already exist)
//   npm run seed:demo -- --force (adds them anyway)
const db = require('../src/db');

db.open();
const d = db.get();
if (d.prepare('SELECT COUNT(*) AS n FROM tickets').get().n > 0 && !process.argv.includes('--force')) {
  console.log('Tickets already exist. Run with --force to add the demo set anyway.');
  process.exit(0);
}
const client = d.prepare('SELECT * FROM clients ORDER BY id LIMIT 1').get();
const agent = d.prepare('SELECT * FROM agents ORDER BY id LIMIT 1').get();

const H = 36e5;
const at = (hoursAgo) => new Date(Date.now() - hoursAgo * H).toISOString().replace(/\.\d{3}Z$/, 'Z');

// [hoursAgo, name, email, subject, description, category, priority, page, stage, risk, extra]
const DEMO = [
  [2, 'Asha Rao', 'asha.rao@example.com', 'Typo on the shop banner', 'The banner on the shop page says "Hactoberfest 2026", missing a k.', 'typo', 'low', '/shop', 'LIVE', 'LOW', { solvedAfter: 0.4, sha: '9f3c2ab17e' }],
  [5, 'Rohan Kulkarni', 'rohan.k@example.com', 'Cart count badge overlaps the bag icon on mobile', 'On my phone the little number on the cart sits on top of the bag icon so you cannot read it.', 'design', 'normal', '/cart', 'IN_PROGRESS', 'LOW', {}],
  [7, 'Meera Patil', 'meera.p@example.com', 'Coupon field looks broken', 'The coupon box at checkout looks weird.', 'bug', 'normal', '/checkout', 'NEEDS_INFO', 'MODERATE', { questions: ['What does "looks weird" mean: misaligned, cut off, or not accepting input?', 'Which phone or browser were you using?'] }],
  [9, 'Kiran Desai', 'kiran.d@example.com', 'Refunds should go to the original card', 'I cancelled an order and want the refund to go back to my card, not store credit.', 'payment', 'high', '/account', 'HUMAN', 'HIGH', { guardrail: 'forced HIGH (was MODERATE): keywords [\'refund\', \'payment\']' }],
  [12, 'Sneha Joshi', 'sneha.j@example.com', 'FAQ answer for pickup time is wrong', 'The FAQ says pickup is from 5 pm but the event schedule says 6 pm.', 'typo', 'low', '/#faq', 'PUSHED', 'LOW', { sha: '4be81c0d92' }],
  [20, 'Arjun Hegde', 'arjun.h@example.com', 'Countdown shows negative minutes', 'The hack-night countdown on the home page shows -3 minutes for a second before updating.', 'bug', 'normal', '/', 'DEPLOYING', 'LOW', { sha: 'c71d55e0aa' }],
  [26, 'Priya Nayak', 'priya.n@example.com', 'Size guide link goes nowhere', 'On the product page "Size guide" does nothing when clicked.', 'bug', 'normal', '/product/hacktoberfest-2026-classic-tee', 'LIVE', 'LOW', { solvedAfter: 1.2, sha: '1a2b3c4d5e' }],
  [30, 'Vikram Shetty', 'vikram.s@example.com', 'Let me log in with Google', 'It would be easier if I could sign in with my Google account.', 'feature', 'low', '/login', 'HUMAN', 'HIGH', { guardrail: 'forced HIGH (was LOW): keywords [\'log in\']' }],
  [40, 'Divya Kamath', 'divya.k@example.com', 'Product images load slowly', 'Pictures on the shop page take a while to appear on campus Wi-Fi.', 'other', 'low', '/shop', 'AGENT_FAILED', 'LOW', { error: 'build failed after 2 attempts: change touched files outside frontend/src/' }],
  [52, 'Nikhil Bhat', 'nikhil.b@example.com', 'Footer says 2025 instead of 2026', 'The footer copyright line still says 2025.', 'typo', 'low', '/', 'LIVE', 'LOW', { solvedAfter: 0.6, sha: '77aa0be3c1' }],
  [70, 'Ananya Rao', 'ananya.r@example.com', 'Free shipping message is confusing', 'The cart says "₹0 away from free shipping" when I already have free shipping.', 'bug', 'normal', '/cart', 'LIVE', 'LOW', { solvedAfter: 2.1, sha: 'e0d1c2b3a4' }],
  [90, 'Sameer Gokhale', 'sameer.g@example.com', 'Delete my account', 'Please delete my account and all my order history.', 'account', 'normal', '/account', 'HUMAN', 'HIGH', { guardrail: 'forced HIGH: keywords [\'delete\', \'account\']', solvedAfter: 20, agentSolved: true }],
  [120, 'Lakshmi Iyer', 'lakshmi.i@example.com', 'Search does not find "pumpkin"', 'Searching for pumpkin shows nothing even though there is a pumpkin costume.', 'bug', 'normal', '/shop', 'LIVE', 'LOW', { solvedAfter: 1.8, sha: '5c6d7e8f90' }],
  [150, 'Rahul Menon', 'rahul.m@example.com', 'Button text cut off on checkout', 'The "Pay with Razorpay" button text gets cut off on small screens.', 'design', 'normal', '/checkout', 'LIVE', 'LOW', { solvedAfter: 0.9, sha: 'aa11bb22cc' }],
  [200, 'Pooja Shenoy', 'pooja.s@example.com', 'Order confirmation email never came', 'I paid but never got an email confirmation.', 'other', 'high', '/order', 'HUMAN', 'MODERATE', { reason: 'The store does not send emails yet; this is a missing feature, not a quick fix.', solvedAfter: 6, agentSolved: true }],
  [260, 'Harsha V', 'harsha.v@example.com', 'Wrong price shown for ghost hoodie', 'The ghost hoodie shows ₹1,299 on the card but ₹1,499 in the cart.', 'bug', 'urgent', '/shop', 'HUMAN', 'HIGH', { guardrail: 'forced HIGH: keywords [\'price\']', solvedAfter: 3, agentSolved: true }],
  [300, 'Tejas Pai', 'tejas.p@example.com', 'Event venue spelling', 'The venue is spelled "Jnana Sangam" in one place and "Jnana Sangama" in another.', 'typo', 'low', '/#event', 'LIVE', 'LOW', { solvedAfter: 0.5, sha: 'f00dfacade' }],
  [1.2, 'Guest', 'guest4471@example.com', 'Newsletter signup button not working', 'I put my email in the newsletter box and pressed subscribe and nothing happened.', 'bug', 'normal', '/', 'NEW', null, {}],
  [0.3, 'Farah Sheikh', 'farah.s@example.com', 'Dark text on dark background in the FAQ', 'In the FAQ some answers are very hard to read, dark grey on dark purple.', 'design', 'low', '/#faq', null, null, { noAutofix: true }]
];

const MSG = {
  QUEUED: 'Good news: our automated fixer has picked this up and is working on a fix now.',
  PUSHED: (sha) => `A fix has been committed (${sha.slice(0, 8)}) and is being deployed.`,
  LIVE: 'The fix is now live on the website. Please check it, and reply here if anything is still wrong.'
};

let n = 0;
{
  for (const [ago, name, email, subject, description, category, priority, page, stage, risk, x] of DEMO) {
    const created = at(ago);
    const row = db.createTicket({
      clientId: client.id, channel: n++ % 3 === 0 ? 'web' : 'api', name, email, subject, description, category, priority,
      pageUrl: `https://trick-or-commit.onrender.com${page}`, createdAt: created
    });
    const id = row.id;
    const msg = (kind, author, body, hoursAfter) =>
      d.prepare('INSERT INTO messages (ticket_id, kind, author, body, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, kind, author, body, at(Math.max(0, ago - hoursAfter)));
    if (x.noAutofix) continue;

    const afId = `VP-${200 + n}`;
    const info = {
      risk, summary: subject, triageCategory: category, taskSpec: risk === 'LOW' ? `Fix: ${subject.toLowerCase()}. Change only frontend/src/.` : null,
      likelyArea: 'frontend/src/pages', questions: x.questions || [], confidence: risk === 'LOW' ? 0.92 : risk ? 0.7 : null,
      reason: x.reason || (risk === 'LOW' ? 'Small, contained frontend change.' : null), guardrail: x.guardrail || null,
      attempts: ['IN_PROGRESS', 'PUSHED', 'DEPLOYING', 'LIVE', 'AGENT_FAILED'].includes(stage) ? 1 : 0, error: x.error || null,
      commitSha: x.sha || null, runUrl: x.sha ? 'https://github.com/Cartlal/Vtu-Hacktoberfest2026/actions' : null,
      deployedAt: stage === 'LIVE' ? at(ago - x.solvedAfter) : null,
      log: x.sha ? `--- attempt 1/2 ---\n[cli] editing frontend/src/...\n[check] passed: 1 file\n[git] pushed ${x.sha.slice(0, 8)} to main` : ''
    };
    msg('system', 'AutoFix', `Sent to AutoFix as ${afId} for Gemma triage.`, 0.01);

    let status = 'new';
    if (stage === 'NEEDS_INFO') {
      msg('autofix', 'AutoFix', `To fix this we need a little more detail:\n${info.questions.map((q) => `- ${q}`).join('\n')}`, 0.05);
      status = 'pending';
    } else if (stage === 'HUMAN') {
      msg('note', 'AutoFix', `Needs a developer: rated ${risk} risk. ${info.guardrail || info.reason || ''}`.trim(), 0.05);
      status = 'open';
      if (x.agentSolved) {
        msg('agent', agent.name, 'Thanks for flagging this. Our developers have sorted it out; let us know if you still see a problem.', x.solvedAfter);
        status = 'solved';
      }
    } else if (stage === 'AGENT_FAILED') {
      msg('autofix', 'AutoFix', MSG.QUEUED, 0.05);
      msg('note', 'AutoFix', `AutoFix could not finish this (AGENT_FAILED). ${info.error}`, 0.3);
      status = 'open';
    } else if (['QUEUED', 'IN_PROGRESS', 'PUSHED', 'DEPLOYING', 'LIVE'].includes(stage)) {
      msg('autofix', 'AutoFix', MSG.QUEUED, 0.05);
      status = 'open';
      if (['PUSHED', 'DEPLOYING', 'LIVE'].includes(stage)) msg('autofix', 'AutoFix', MSG.PUSHED(x.sha), Math.min(0.2, ago * 0.5));
      if (stage === 'LIVE') { msg('autofix', 'AutoFix', MSG.LIVE, x.solvedAfter); status = 'solved'; }
    }
    const solvedAt = status === 'solved' ? at(ago - x.solvedAfter) : null;
    const firstReply = stage && stage !== 'NEW' && stage !== 'HUMAN' ? at(Math.max(0, ago - 0.05)) : (x.agentSolved ? at(ago - x.solvedAfter) : null);
    d.prepare(`UPDATE tickets SET status = ?, autofix_id = ?, autofix_stage = ?, autofix_json = ?, autofix_synced_at = ?,
               solved_at = ?, first_reply_at = ?, assignee_id = ?, updated_at = ? WHERE id = ?`)
      .run(status, afId, stage, JSON.stringify(info), at(0), solvedAt, firstReply,
           x.agentSolved || stage === 'HUMAN' ? agent.id : null, solvedAt || at(Math.max(0, ago - 0.3)), id);
  }
}
console.log(`Added ${DEMO.length} demo tickets for ${client.name}.`);
