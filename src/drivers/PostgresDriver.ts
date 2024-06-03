import { LogError } from "../utils";
import AbstractDriver from "./AbstractDriver";
import { IRDMSConnectionOptions } from "../types";
import { Entity } from "../models/Entity";
import { Column } from "../models/Column";
import { Index } from "../models/Index";
import { RelationInternal } from "../models/RelationInternal";
import {
  COLUMN_TYPES_WITH_LENGTH,
  COLUMN_TYPES_WITH_PRECISION,
  COLUMN_TYPES_WITH_WIDTH,
} from "./_constants";

const schemas = ["public"];

export default class PostgresDriver extends AbstractDriver {
  constructor(connectionOptions: IRDMSConnectionOptions) {
    super(connectionOptions);
  }

  public formatQuery<T>(data: { rows: unknown }) {
    return data.rows as T[];
  }

  public async GetAllTables(): Promise<Entity[]> {
    const response = await this.runQuery<{
      TABLE_SCHEMA: string;
      TABLE_NAME: string;
      DB_NAME: string;
    }>(
      `SELECT table_schema as "TABLE_SCHEMA",table_name as "TABLE_NAME", table_catalog as "DB_NAME" FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' AND table_schema in (${PostgresDriver.buildEscapedObjectList(
        schemas
      )})`
    );
    const ret: Entity[] = [];
    response.forEach((val) => {
      ret.push({
        columns: [],
        indices: [],
        relations: [],
        relationIds: [],
        name: val.TABLE_NAME,
        schema: val.TABLE_SCHEMA,
      });
    });
    return ret;
  }

  public async GetCoulmnsFromEntity(entities: Entity[]): Promise<Entity[]> {
    const response = await this.runQuery<{
      /* eslint-disable camelcase */
      table_name: string;
      column_name: string;
      udt_name: string;
      column_default: string;
      is_nullable: string;
      data_type: string;
      character_maximum_length: number;
      numeric_precision: number;
      numeric_scale: number;
      isidentity: string; // SERIAL identity type
      is_identity: string; // reccommended INDENTITY type for pg > 10
      isunique: string;
      enumvalues: string | null;
      /* eslint-enable camelcase */
    }>(
      `SELECT table_name,column_name,udt_name,column_default,is_nullable,
                    data_type,character_maximum_length,numeric_precision,numeric_scale,
                    case when column_default LIKE 'nextval%' then 'YES' else 'NO' end isidentity,
                    is_identity,
        			(SELECT count(*)
            FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                inner join INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE cu
                    on cu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
            where
                tc.CONSTRAINT_TYPE = 'UNIQUE'
                and tc.TABLE_NAME = c.TABLE_NAME
                and cu.COLUMN_NAME = c.COLUMN_NAME
                and tc.TABLE_SCHEMA=c.TABLE_SCHEMA) IsUnique,
                (SELECT
        string_agg(enumlabel, ',')
        FROM "pg_enum" "e"
        INNER JOIN "pg_type" "t" ON "t"."oid" = "e"."enumtypid"
        INNER JOIN "pg_namespace" "n" ON "n"."oid" = "t"."typnamespace"
        WHERE "n"."nspname" = table_schema AND "t"."typname"=udt_name
                ) enumValues
                    FROM INFORMATION_SCHEMA.COLUMNS c
                    where table_schema in (${PostgresDriver.buildEscapedObjectList(
                      schemas
                    )})
        			order by ordinal_position`
    );

    entities.forEach((ent) => {
      response
        .filter((filterVal) => filterVal.table_name === ent.name)
        .forEach((resp) => {
          const tscName = resp.column_name;
          const options: Column["options"] = {
            name: resp.column_name,
          };
          if (resp.is_nullable === "YES") options.nullable = true;
          if (resp.isunique === "1") options.unique = true;

          const generated =
            resp.isidentity === "YES" || resp.is_identity === "YES"
              ? true
              : undefined;
          const defaultValue = generated
            ? undefined
            : PostgresDriver.ReturnDefaultValueFunction(
                resp.column_default,
                resp.data_type
              );

          const columnTypes = this.MatchColumnTypes(
            resp.data_type,
            resp.udt_name,
            resp.enumvalues
          );
          if (columnTypes.tsType === "NonNullable<unknown>") {
            if (
              resp.data_type === "USER-DEFINED" ||
              resp.data_type === "ARRAY"
            ) {
              LogError(
                `Unknown ${resp.data_type} column type: ${resp.udt_name} table name: ${resp.table_name} column name: ${resp.column_name}`
              );
            } else {
              LogError(
                `Unknown column type: ${resp.data_type} table name: ${resp.table_name} column name: ${resp.column_name}`
              );
            }
            return;
          }

          const columnType = columnTypes.sqlType;
          let tscType = columnTypes.tsType;
          if (columnTypes.isArray) options.array = true;
          if (columnTypes.enumValues.length > 0)
            options.enum = columnTypes.enumValues;
          if (options.array) {
            tscType = tscType
              .split("|")
              .map((x) => `${x.replace("|", "").trim()}[]`)
              .join(" | ");
          }

          if (COLUMN_TYPES_WITH_PRECISION.some((v) => v === columnType)) {
            if (resp.numeric_precision !== null) {
              options.precision = resp.numeric_precision;
            }
            if (resp.numeric_scale !== null) {
              options.scale = resp.numeric_scale;
            }
          }
          if (COLUMN_TYPES_WITH_LENGTH.some((v) => v === columnType)) {
            options.length =
              resp.character_maximum_length > 0
                ? resp.character_maximum_length
                : undefined;
          }
          if (COLUMN_TYPES_WITH_WIDTH.some((v) => v === columnType)) {
            options.width =
              resp.character_maximum_length > 0
                ? resp.character_maximum_length
                : undefined;
          }

          ent.columns.push({
            generated,
            type: columnType,
            default: defaultValue,
            options,
            tscName,
            tscType,
          });
        });
    });
    return entities;
  }

  public MatchColumnTypes(
    dataType: string,
    udtName: string,
    enumValues: string | null
  ) {
    let ret: {
      tsType: Column["tscType"];
      sqlType: string;
      isArray: boolean;
      enumValues: string[];
    } = {
      tsType: "",
      sqlType: dataType,
      isArray: false,
      enumValues: [],
    };
    switch (dataType) {
      case "int2":
        ret.tsType = "number";
        break;
      case "int4":
        ret.tsType = "number";
        break;
      case "int8":
        ret.tsType = "number";
        break;
      case "smallint":
        ret.tsType = "number";
        break;
      case "integer":
        ret.tsType = "number";
        break;
      case "bigint":
        ret.tsType = "number";
        break;
      case "decimal":
        ret.tsType = "number";
        break;
      case "numeric":
        ret.tsType = "number";
        break;
      case "real":
        ret.tsType = "number";
        break;
      case "float":
        ret.tsType = "number";
        break;
      case "float4":
        ret.tsType = "number";
        break;
      case "float8":
        ret.tsType = "number";
        break;
      case "double precision":
        ret.tsType = "number";
        break;
      case "money":
        ret.tsType = "number";
        break;
      case "character varying":
        ret.tsType = "string";
        break;
      case "varchar":
        ret.tsType = "string";
        break;
      case "character":
        ret.tsType = "string";
        break;
      case "char":
        ret.tsType = "string";
        break;
      case "bpchar":
        ret.sqlType = "char";
        ret.tsType = "string";
        break;
      case "text":
        ret.tsType = "string";
        break;
      case "citext":
        ret.tsType = "string";
        break;
      case "hstore":
        ret.tsType = "string";
        break;
      case "bytea":
        ret.tsType = "Buffer";
        break;
      case "bit":
        ret.tsType = "string";
        break;
      case "varbit":
        ret.tsType = "string";
        break;
      case "bit varying":
        ret.tsType = "string";
        break;
      case "timetz":
        ret.tsType = "string";
        break;
      case "timestamptz":
        ret.tsType = "Date";
        break;
      case "timestamp":
        ret.tsType = "string";
        break;
      case "timestamp without time zone":
        ret.tsType = "Date";
        break;
      case "timestamp with time zone":
        ret.tsType = "Date";
        break;
      case "date":
        ret.tsType = "string";
        break;
      case "time":
        ret.tsType = "string";
        break;
      case "time without time zone":
        ret.tsType = "string";
        break;
      case "time with time zone":
        ret.tsType = "string";
        break;
      case "interval":
        ret.tsType = "any";
        break;
      case "bool":
        ret.tsType = "boolean";
        break;
      case "boolean":
        ret.tsType = "boolean";
        break;
      case "point":
        ret.tsType = "string | object";
        break;
      case "line":
        ret.tsType = "string";
        break;
      case "lseg":
        ret.tsType = "string | string[]";
        break;
      case "box":
        ret.tsType = "string | object";
        break;
      case "path":
        ret.tsType = "string";
        break;
      case "polygon":
        ret.tsType = "string";
        break;
      case "circle":
        ret.tsType = "string | object";
        break;
      case "cidr":
        ret.tsType = "string";
        break;
      case "inet":
        ret.tsType = "string";
        break;
      case "macaddr":
        ret.tsType = "string";
        break;
      case "tsvector":
        ret.tsType = "string";
        break;
      case "tsquery":
        ret.tsType = "string";
        break;
      case "uuid":
        ret.tsType = "string";
        break;
      case "xml":
        ret.tsType = "string";
        break;
      case "json":
        ret.tsType = "object";
        break;
      case "jsonb":
        ret.tsType = "object";
        break;
      case "int4range":
        ret.tsType = "string";
        break;
      case "int8range":
        ret.tsType = "string";
        break;
      case "numrange":
        ret.tsType = "string";
        break;
      case "tsrange":
        ret.tsType = "string";
        break;
      case "tstzrange":
        ret.tsType = "string";
        break;
      case "daterange":
        ret.tsType = "string";
        break;
      case "ARRAY":
        ret = this.MatchColumnTypes(udtName.substring(1), udtName, enumValues);
        ret.isArray = true;
        break;
      case "USER-DEFINED":
        ret.tsType = "string";
        switch (udtName) {
          case "citext":
          case "hstore":
          case "geography":
          case "geometry":
          case "ltree":
            ret.sqlType = udtName;
            break;
          default:
            if (enumValues) {
              ret.tsType = `"${enumValues
                .split(",")
                .join('" | "')}"` as never as string;
              ret.sqlType = "enum";
              ret.enumValues = enumValues.split(",");
            }
            break;
        }
        break;
      default:
        ret.tsType = "NonNullable<unknown>";
        break;
    }
    return ret;
  }

  public async GetIndexesFromEntity(entities: Entity[]): Promise<Entity[]> {
    const response = await this.runQuery<{
      tablename: string;
      indexname: string;
      columnname: string;
      // eslint-disable-next-line camelcase
      is_unique: number;
      // eslint-disable-next-line camelcase
      is_primary_key: number;
    }>(`SELECT
        c.relname AS tablename,
        i.relname as indexname,
        f.attname AS columnname,
        CASE
            WHEN ix.indisunique = true THEN 1
            ELSE 0
        END AS is_unique,
        CASE
            WHEN ix.indisprimary='true' THEN 1
            ELSE 0
        END AS is_primary_key
        FROM pg_attribute f
        JOIN pg_class c ON c.oid = f.attrelid
        JOIN pg_type t ON t.oid = f.atttypid
        LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = f.attnum
        LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_index AS ix ON f.attnum = ANY(ix.indkey) and c.oid = f.attrelid and c.oid = ix.indrelid
        LEFT JOIN pg_class AS i ON ix.indexrelid = i.oid
        WHERE c.relkind = 'r'::char
        AND n.nspname in (${PostgresDriver.buildEscapedObjectList(schemas)})
        AND f.attnum > 0
        AND i.oid<>0
        ORDER BY c.relname,f.attname;`);

    entities.forEach((ent) => {
      const entityIndices = response.filter(
        (filterVal) => filterVal.tablename === ent.name
      );
      const indexNames = new Set(entityIndices.map((v) => v.indexname));
      indexNames.forEach((indexName) => {
        const records = entityIndices.filter((v) => v.indexname === indexName);
        const indexInfo: Index = {
          columns: [],
          options: {},
          name: records[0].indexname,
        };
        if (records[0].is_primary_key === 1) indexInfo.primary = true;
        if (records[0].is_unique === 1) indexInfo.options.unique = true;
        records.forEach((record) => {
          indexInfo.columns.push(record.columnname);
        });
        ent.indices.push(indexInfo);
      });
    });

    return entities;
  }

  public async GetRelations(entities: Entity[]): Promise<Entity[]> {
    const response = await this.runQuery<{
      tablewithforeignkey: string;
      // eslint-disable-next-line camelcase
      fk_partno: number;
      foreignkeycolumn: string;
      tablereferenced: string;
      foreignkeycolumnreferenced: string;
      ondelete: "RESTRICT" | "CASCADE" | "SET NULL" | "NO ACTION";
      onupdate: "RESTRICT" | "CASCADE" | "SET NULL" | "NO ACTION";
      // eslint-disable-next-line camelcase
      object_id: string;
      // Distinct because of note in https://www.postgresql.org/docs/9.1/information-schema.html
    }>(`SELECT DISTINCT
            con.relname AS tablewithforeignkey,
            att.attnum as fk_partno,
                 att2.attname AS foreignkeycolumn,
              cl.relname AS tablereferenced,
              att.attname AS foreignkeycolumnreferenced,
              delete_rule as ondelete,
              update_rule as onupdate,
                concat(con.conname,con.conrelid,con.confrelid) as object_id
               FROM (
                   SELECT
                     unnest(con1.conkey) AS parent,
                     unnest(con1.confkey) AS child,
                     con1.confrelid,
                     con1.conrelid,
                     cl_1.relname,
                   con1.conname,
                   nspname
                   FROM
                     pg_class cl_1,
                     pg_namespace ns,
                     pg_constraint con1
                   WHERE
                     con1.contype = 'f'::"char"
                     AND cl_1.relnamespace = ns.oid
                     AND con1.conrelid = cl_1.oid
                     and nspname in (${PostgresDriver.buildEscapedObjectList(
                       schemas
                     )})
              ) con,
                pg_attribute att,
                pg_class cl,
                pg_attribute att2,
                information_schema.referential_constraints rc
              WHERE
                att.attrelid = con.confrelid
                AND att.attnum = con.child
                AND cl.oid = con.confrelid
                AND att2.attrelid = con.conrelid
                AND att2.attnum = con.parent
                AND rc.constraint_name= con.conname AND constraint_catalog=current_database() AND rc.constraint_schema=nspname
                `);

    const relationsTemp: RelationInternal[] = [] as RelationInternal[];
    const relationKeys = new Set(response.map((v) => v.object_id));

    relationKeys.forEach((relationId) => {
      const rows = response.filter((v) => v.object_id === relationId);
      const ownerTable = entities.find(
        (v) => v.name === rows[0].tablewithforeignkey
      );
      const relatedTable = entities.find(
        (v) => v.name === rows[0].tablereferenced
      );
      if (!ownerTable || !relatedTable) {
        LogError(
          `Relation between tables ${rows[0].tablewithforeignkey} and ${rows[0].tablereferenced} wasn't found in entity model.`
        );
        return;
      }
      const internal: RelationInternal = {
        ownerColumns: [],
        relatedColumns: [],
        ownerTable,
        relatedTable,
      };
      rows.forEach((row) => {
        internal.ownerColumns.push(row.foreignkeycolumn);
        internal.relatedColumns.push(row.foreignkeycolumnreferenced);
      });
      relationsTemp.push(internal);
    });

    const retVal = PostgresDriver.GetRelationsFromRelationTempInfo(
      relationsTemp,
      entities
    );
    return retVal;
  }

  public async CheckIfDBExists(dbName: string): Promise<boolean> {
    const resp = await this.runQuery(
      `SELECT datname FROM pg_database  WHERE datname  ='${dbName}' `
    );
    return resp.length > 0;
  }

  private static ReturnDefaultValueFunction(
    defVal: string | null,
    dataType: string
  ): string | undefined {
    let defaultValue = defVal;
    if (!defaultValue) {
      return undefined;
    }
    defaultValue = defaultValue.replace(/'::[\w ]*/, "'");

    if (["json", "jsonb"].some((x) => x === dataType)) {
      return `${defaultValue.slice(1, defaultValue.length - 1)}`;
    }
    return `() => "${defaultValue}"`;
  }
}
