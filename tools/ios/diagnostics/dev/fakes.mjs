// Local stand-ins for the Worker's bindings: D1 on node:sqlite and a rate
// limiter that always allows. For the tests and the local dev server; nothing
// here talks to Cloudflare.

import {DatabaseSync} from 'node:sqlite';

class Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new Statement(this.db, this.sql, args);
  }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.args);
    return {success: true, meta: {changes: Number(info.changes)}};
  }
  async all() {
    return {results: this.db.prepare(this.sql).all(...this.args)};
  }
  async first() {
    return this.db.prepare(this.sql).get(...this.args) ?? null;
  }
}

export function fakeD1(path = ':memory:', schema) {
  const db = new DatabaseSync(path);
  if (schema) db.exec(schema);
  return {
    sqlite: db,
    prepare: (sql) => new Statement(db, sql),
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

export const allowAll = {async limit() { return {success: true}; }};
