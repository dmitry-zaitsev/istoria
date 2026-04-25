//! Datadog-style query language. Parsed once with chumsky into an
//! `Ast`, then evaluated either as SQL (cold queries against DuckDB)
//! or AST-walked over an `Event` (live tail, in TS this is mirrored
//! in `src/lib/query.ts`).

use chumsky::prelude::*;
use serde::Serialize;

/// Parsed query AST. Top-level expression.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Ast {
    /// `key:value`
    KeyExact { key: String, value: String },
    /// `key:>=N`, `key:<N`, etc.
    KeyCmp { key: String, op: CmpOp, value: f64 },
    /// `key~/regex/`
    KeyRegex { key: String, pattern: String },
    /// Free-text substring match on `msg`.
    Free { term: String },
    And { left: Box<Ast>, right: Box<Ast> },
    Or { left: Box<Ast>, right: Box<Ast> },
    Not { expr: Box<Ast> },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CmpOp {
    Lt,
    Lte,
    Gt,
    Gte,
}

#[derive(Clone, Debug)]
pub struct ParseError {
    pub message: String,
    pub span: std::ops::Range<usize>,
}

pub fn parse(input: &str) -> Result<Ast, ParseError> {
    if input.trim().is_empty() {
        return Ok(Ast::Free { term: String::new() });
    }
    let parser = parser();
    parser.parse(input).map_err(|errs| {
        let e = errs.into_iter().next().unwrap_or_else(|| Simple::custom(0..0, "empty"));
        ParseError {
            message: format!("{e}"),
            span: e.span(),
        }
    })
}

fn parser() -> impl Parser<char, Ast, Error = Simple<char>> {
    let ident = filter::<_, _, Simple<char>>(|c: &char| c.is_alphanumeric() || *c == '.' || *c == '_')
        .repeated()
        .at_least(1)
        .collect::<String>()
        .padded();

    let bare_value = filter::<_, _, Simple<char>>(|c: &char| {
        !c.is_whitespace() && *c != ')' && *c != '('
    })
    .repeated()
    .at_least(1)
    .collect::<String>();

    let quoted_value = just('"')
        .ignore_then(filter::<_, _, Simple<char>>(|c| *c != '"').repeated().collect::<String>())
        .then_ignore(just('"'));

    let value = quoted_value.or(bare_value);

    // numeric comparison ops: >=, <=, >, <
    let cmp_op = choice((
        just(">=").to(CmpOp::Gte),
        just("<=").to(CmpOp::Lte),
        just(">").to(CmpOp::Gt),
        just("<").to(CmpOp::Lt),
    ));

    // RHS of a numeric cmp accepts:
    //   - a plain number (`123`, `-1.5`)
    //   - a quoted or bare ISO datetime that resolves to Unix-ms
    // The AST always stores the value as f64 (Unix-ms for dates).
    let cmp_bare = filter::<_, _, Simple<char>>(|c: &char| {
        !c.is_whitespace() && *c != ')' && *c != '('
    })
    .repeated()
    .at_least(1)
    .collect::<String>();
    let cmp_value = quoted_value
        .clone()
        .or(cmp_bare)
        .try_map(|s, span| {
            parse_num_or_date(&s).ok_or_else(|| {
                Simple::custom(span, format!("expected number or datetime, got '{s}'"))
            })
        });

    let key_cmp = ident
        .clone()
        .then_ignore(just(':'))
        .then(cmp_op)
        .then(cmp_value)
        .map(|((key, op), value)| Ast::KeyCmp { key, op, value });

    // key~/regex/  — slash-delimited; backslash escapes any next char
    // so `\/` represents a literal `/` inside the pattern.
    let escape = just::<char, _, Simple<char>>('\\')
        .then(any())
        .map(|(a, b)| {
            let mut s = String::with_capacity(2);
            s.push(a);
            s.push(b);
            s
        });
    let regex_char = escape.or(filter::<_, _, Simple<char>>(|c: &char| *c != '/' && *c != '\\')
        .map(|c| c.to_string()));
    let regex_body = regex_char.repeated().collect::<Vec<_>>().map(|v| v.concat());
    let key_regex = ident
        .clone()
        .then_ignore(just('~'))
        .then_ignore(just('/'))
        .then(regex_body)
        .then_ignore(just('/'))
        .map(|(key, pattern)| Ast::KeyRegex { key, pattern });

    let key_exact = ident
        .clone()
        .then_ignore(just(':'))
        .then(value.clone())
        .map(|(key, value)| Ast::KeyExact { key, value });

    let free = filter::<_, _, Simple<char>>(|c: &char| {
        !c.is_whitespace() && *c != ')' && *c != '('
    })
    .repeated()
    .at_least(1)
    .collect::<String>()
    .try_map(|s, span| {
        let lower = s.to_ascii_lowercase();
        if matches!(lower.as_str(), "and" | "or" | "not") {
            Err(Simple::custom(span, "operator in free-term position"))
        } else {
            Ok(Ast::Free { term: s })
        }
    });

    recursive(|expr| {
        let atom = choice((
            key_regex.clone(),
            key_cmp.clone(),
            key_exact.clone(),
            expr.clone()
                .delimited_by(just('(').padded(), just(')').padded()),
            free.clone(),
        ))
        .padded();

        let unary = just::<_, _, Simple<char>>("NOT")
            .padded()
            .repeated()
            .then(atom)
            .foldr(|_, rhs| Ast::Not { expr: Box::new(rhs) });

        let and = unary
            .clone()
            .then(
                just::<_, _, Simple<char>>("AND")
                    .padded()
                    .ignore_then(unary.clone())
                    .repeated(),
            )
            .foldl(|lhs, rhs| Ast::And { left: Box::new(lhs), right: Box::new(rhs) });

        and.clone()
            .then(
                just::<_, _, Simple<char>>("OR")
                    .padded()
                    .ignore_then(and)
                    .repeated(),
            )
            .foldl(|lhs, rhs| Ast::Or { left: Box::new(lhs), right: Box::new(rhs) })
    })
    .then_ignore(end())
}

/// Parse a comparison RHS as a JS-style number or a date-like
/// string. Date-like values resolve to Unix ms so the AST stays
/// uniformly numeric. Mirrors the TS `parseNumberOrDate`.
fn parse_num_or_date(s: &str) -> Option<f64> {
    if let Ok(n) = s.parse::<f64>() {
        return Some(n);
    }
    use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime};
    if let Ok(dt) = DateTime::<FixedOffset>::parse_from_rfc3339(s) {
        return Some(dt.timestamp_millis() as f64);
    }
    let dt_formats = [
        "%Y-%m-%dT%H:%M:%S%.3f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S%.3f",
        "%Y-%m-%d %H:%M:%S",
    ];
    for f in dt_formats {
        if let Ok(dt) = NaiveDateTime::parse_from_str(s, f) {
            return Some(dt.and_utc().timestamp_millis() as f64);
        }
    }
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return d
            .and_hms_opt(0, 0, 0)
            .map(|dt| dt.and_utc().timestamp_millis() as f64);
    }
    None
}

/// Lower an AST to a SQL `WHERE` clause fragment plus a list of
/// positional parameters. Path expressions (`user.id`) become
/// `json_extract(fields, '$.user.id')`. Top-level columns (`level`,
/// `source`, `msg`) bypass the JSON extractor.
pub fn to_sql(ast: &Ast) -> (String, Vec<SqlParam>) {
    let mut params: Vec<SqlParam> = Vec::new();
    let sql = walk(ast, &mut params);
    (sql, params)
}

#[derive(Clone, Debug)]
pub enum SqlParam {
    Text(String),
    Number(f64),
}

fn column_for(key: &str) -> String {
    match key {
        "level" | "source" | "msg" | "raw" => key.to_string(),
        _ => format!("json_extract(fields, '$.{}')", escape_path(key)),
    }
}

fn escape_path(key: &str) -> String {
    key.replace('\'', "''")
}

fn walk(ast: &Ast, p: &mut Vec<SqlParam>) -> String {
    match ast {
        Ast::Free { term } if term.is_empty() => "TRUE".into(),
        Ast::Free { term } => {
            p.push(SqlParam::Text(format!("%{term}%")));
            "msg ILIKE ?".into()
        }
        Ast::KeyExact { key, value } => {
            // Wildcard: `*` anywhere in the value switches to glob
            // match via DuckDB ILIKE (`*` → `%`).
            if value.contains('*') {
                let pat = value.replace('*', "%");
                p.push(SqlParam::Text(pat));
                return format!("CAST({} AS VARCHAR) ILIKE ?", column_for(key));
            }
            // msg/raw treated as case-insensitive substring; other
            // columns are exact equality matches.
            if key == "msg" || key == "raw" {
                p.push(SqlParam::Text(format!("%{}%", value)));
                format!("{} ILIKE ?", column_for(key))
            } else {
                p.push(SqlParam::Text(value.clone()));
                format!("{} = ?", column_for(key))
            }
        }
        Ast::KeyCmp { key, op, value } => {
            p.push(SqlParam::Number(*value));
            let op = match op {
                CmpOp::Lt => "<",
                CmpOp::Lte => "<=",
                CmpOp::Gt => ">",
                CmpOp::Gte => ">=",
            };
            format!("CAST({} AS DOUBLE) {} ?", column_for(key), op)
        }
        Ast::KeyRegex { key, pattern } => {
            p.push(SqlParam::Text(pattern.clone()));
            format!("regexp_matches(CAST({} AS VARCHAR), ?)", column_for(key))
        }
        Ast::And { left, right } => format!("({} AND {})", walk(left, p), walk(right, p)),
        Ast::Or { left, right } => format!("({} OR {})", walk(left, p), walk(right, p)),
        Ast::Not { expr } => format!("(NOT {})", walk(expr, p)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_query_is_free_empty() {
        assert_eq!(parse("").unwrap(), Ast::Free { term: "".into() });
        assert_eq!(parse("   ").unwrap(), Ast::Free { term: "".into() });
    }

    #[test]
    fn key_value_exact() {
        assert_eq!(
            parse("level:error").unwrap(),
            Ast::KeyExact { key: "level".into(), value: "error".into() }
        );
    }

    #[test]
    fn dotted_path() {
        assert_eq!(
            parse("user.id:42").unwrap(),
            Ast::KeyExact { key: "user.id".into(), value: "42".into() }
        );
    }

    #[test]
    fn numeric_cmp() {
        assert_eq!(
            parse("status_code:>=400").unwrap(),
            Ast::KeyCmp { key: "status_code".into(), op: CmpOp::Gte, value: 400.0 }
        );
    }

    #[test]
    fn regex_match() {
        assert_eq!(
            parse("path~/api\\/v1/").unwrap(),
            Ast::KeyRegex { key: "path".into(), pattern: "api\\/v1".into() }
        );
    }

    #[test]
    fn and_or_not() {
        let ast = parse("level:error AND source:api").unwrap();
        assert!(matches!(ast, Ast::And { .. }));
        let ast = parse("level:error OR level:warn").unwrap();
        assert!(matches!(ast, Ast::Or { .. }));
        let ast = parse("NOT level:debug").unwrap();
        assert!(matches!(ast, Ast::Not { .. }));
    }

    #[test]
    fn parens_group() {
        let ast = parse("(level:error OR level:warn) AND source:api").unwrap();
        match ast {
            Ast::And { left, .. } => assert!(matches!(*left, Ast::Or { .. })),
            other => panic!("expected AND, got {other:?}"),
        }
    }

    #[test]
    fn free_term_ilike() {
        let (sql, params) = to_sql(&parse("boom").unwrap());
        assert_eq!(sql, "msg ILIKE ?");
        match &params[0] {
            SqlParam::Text(s) => assert_eq!(s, "%boom%"),
            _ => panic!(),
        }
    }

    #[test]
    fn sql_for_dotted_path() {
        let (sql, _) = to_sql(&parse("user.id:42").unwrap());
        assert_eq!(sql, "json_extract(fields, '$.user.id') = ?");
    }

    #[test]
    fn sql_for_numeric_cmp() {
        let (sql, _) = to_sql(&parse("status_code:>=400").unwrap());
        assert_eq!(sql, "CAST(json_extract(fields, '$.status_code') AS DOUBLE) >= ?");
    }

    #[test]
    fn sql_top_level_column_skips_json() {
        let (sql, _) = to_sql(&parse("level:error").unwrap());
        assert_eq!(sql, "level = ?");
    }

    #[test]
    fn invalid_parse_errors() {
        // Unclosed paren must error.
        assert!(parse("(level:error").is_err());
    }

    #[test]
    fn cmp_accepts_iso_datetime() {
        let ast = parse("ts:>=2026-04-25T14:02:31").unwrap();
        match ast {
            Ast::KeyCmp { key, op, value } => {
                assert_eq!(key, "ts");
                assert_eq!(op, CmpOp::Gte);
                // 2026-04-25T14:02:31 UTC → 1777125751000
                assert_eq!(value as i64, 1_777_125_751_000);
            }
            other => panic!("expected KeyCmp, got {other:?}"),
        }
    }

    #[test]
    fn cmp_accepts_quoted_date_with_space() {
        let ast = parse("ts:>=\"2026-04-25 14:02:31\"").unwrap();
        match ast {
            Ast::KeyCmp { value, .. } => assert_eq!(value as i64, 1_777_125_751_000),
            other => panic!("expected KeyCmp, got {other:?}"),
        }
    }
}
