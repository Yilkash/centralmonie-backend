import 'dotenv/config';
import { applyMigrations } from './migrate';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

applyMigrations(url).then(() => console.log('Migrations applied'));
