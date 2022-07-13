import { IConnectionOptions } from "./types";

export const option : IConnectionOptions = {
    databaseType: "postgres",
    user: "postgres",
    host: "localhost",
    password: "password",
    schemaNames: ['public'],
    databaseName: "my_database",
    port: 5432,
    ssl: false,
};