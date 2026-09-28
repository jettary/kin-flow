import { randomUUID } from 'node:crypto';
import type { Database } from './db';
import { createFamily, mutate } from './service';
import { categoryTemplates, sourceTemplates, type User } from '../lib/model';
import { localDate, shiftMonth } from '../lib/money';
export async function seedDemo(db: Database): Promise<User> {
  const id = randomUUID();
  const user: User = { id, name: 'Alex Morgan' };
  await db.query('INSERT INTO users(id,google_id,name) VALUES($1,$2,$3)', [
    id,
    'demo-' + id,
    user.name,
  ]);
  const family = await createFamily(db, user, {
    name: 'The Morgan family',
    currency: 'GEL',
    timezone: 'Asia/Tbilisi',
    templates: [...categoryTemplates, ...sourceTemplates].map((t) => t[0]),
  });
  const today = localDate(family.timezone),
    month = today.slice(0, 7);
  await db.query('UPDATE families SET created_at=$1 WHERE id=$2', [
    shiftMonth(month, -4) + '-08T12:00:00Z',
    family.id,
  ]);
  await db.query('INSERT INTO exchange_rates(id,data) VALUES(1,$1) ON CONFLICT(id) DO NOTHING', [
    JSON.stringify({
      date: today,
      fetchedAt: new Date().toISOString(),
      provider: 'Illustrative demo rates',
      rates: { USD: '1', GEL: '2.70', EUR: '0.92', GBP: '0.77', JPY: '145' },
    }),
  ]);
  await db.query(
    "INSERT INTO rate_snapshots(fetched_at,data) SELECT data->>'fetchedAt',data FROM exchange_rates ON CONFLICT DO NOTHING",
  );
  const save = async (command: string, input: Record<string, unknown>) =>
    mutate(db, user, family.id, { id: randomUUID(), command, input });
  const card = (
    await save('entity.save', {
      kind: 'account',
      name: 'Everyday card',
      icon: 'card',
      currency: 'GEL',
      accountType: 'Card',
      bank: 'Bank of Georgia',
      openingBalance: '4200',
      included: true,
    })
  ).id;
  const cash = (
    await save('entity.save', {
      kind: 'account',
      name: 'Cash wallet',
      icon: 'wallet',
      currency: 'GEL',
      accountType: 'Cash',
      openingBalance: '380',
      included: true,
    })
  ).id;
  await save('entity.save', {
    kind: 'account',
    name: 'Rainy day fund',
    icon: 'landmark',
    currency: 'GEL',
    accountType: 'Deposit',
    bank: 'TBC Bank',
    openingBalance: '12000',
    included: false,
  });
  const personal = (
    await save('entity.save', {
      kind: 'account',
      name: 'My personal card',
      icon: 'card',
      currency: 'USD',
      accountType: 'Card',
      openingBalance: '650',
      included: true,
      ownerId: id,
    })
  ).id;
  const labels = (
    await db.query<{ id: string; data: { name: string }; kind: string }>(
      'SELECT id,data,kind FROM entities WHERE family_id=$1',
      [family.id],
    )
  ).rows;
  const label = (name: string) => labels.find((l) => l.data.name === name)!.id;
  for (const [name, limit] of [
    ['Groceries', '900'],
    ['Restaurants', '400'],
    ['Transport', '250'],
    ['Shopping', '500'],
    ['Rent', '1500'],
  ])
    await save('budget.save', { categoryId: label(name), limit, currency: 'GEL' });
  await save('transaction.save', {
    type: 'income',
    accountId: card,
    categoryId: label('Salary'),
    amount: '5800',
    currency: 'GEL',
    date: month + '-01',
    comment: 'September salary'.replace(
      'September',
      new Date(today + 'T12:00:00Z').toLocaleString('en', { month: 'long' }),
    ),
    tags: [],
  });
  const entries = [
    ['Rent', '1450', 'Our home', 'home'],
    ['Groceries', '186.40', 'Weekly groceries · Carrefour', 'essentials'],
    ['Restaurants', '72', 'Saturday brunch', 'weekend'],
    ['Transport', '48.50', 'Fuel stop', 'car'],
    ['Groceries', '124.80', 'Market & fresh produce', 'essentials'],
    ['Shopping', '189', 'A little something for home', 'home'],
    ['Restaurants', '64', 'Dinner with the family', 'family'],
    ['Groceries', '98.60', 'The neighbourhood grocery', 'essentials'],
  ];
  for (let i = 0; i < entries.length; i++) {
    const [category, amount, comment, tag] = entries[i];
    const day = Math.max(1, +today.slice(8) - (entries.length - 1 - i));
    await save('transaction.save', {
      type: 'expense',
      accountId: i === 3 ? cash : card,
      categoryId: label(category),
      amount,
      currency: 'GEL',
      date: `${month}-${String(day).padStart(2, '0')}`,
      comment,
      tags: [tag],
    });
  }
  for (let n = 1; n <= 3; n++)
    await save('transaction.save', {
      type: 'expense',
      accountId: card,
      categoryId: label('Groceries'),
      amount: String(600 + n * 60),
      currency: 'GEL',
      date: shiftMonth(month, -n) + '-12',
      comment: 'Previous month groceries',
      tags: ['essentials'],
    });
  const privateCategory = (
    await save('entity.save', {
      kind: 'expense',
      name: 'Coffee & little things',
      icon: 'coffee',
      ownerId: id,
    })
  ).id;
  await save('transaction.save', {
    type: 'expense',
    accountId: personal,
    categoryId: privateCategory,
    amount: '12.50',
    currency: 'USD',
    date: today,
    comment: 'A quiet coffee break',
    tags: ['coffee'],
  });
  return user;
}
