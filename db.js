import postgres from 'postgres';
import env from "dotenv";

env.config();

const connectionString = process.env.DATABASE_URL;
const sql = postgres(connectionString, { ssl: "require" });

export default sql;