import fs from "fs";
import process from "process";
import { dedent } from "./dedent";

const DEBUG = process.env.DEBUG === "1";

function debug(msg: string | (() => string)) {
  if (!DEBUG) {
    return;
  }
  if (typeof msg === "function") {
    msg = msg();
  }
  console.log(msg);
}

const tokenPatterns = [
  ["boolean", /^(?:true|false)/],
  ["comment", /^#[^\r\n]*/],
  ["float", /^(?:-?\d*\.\d+|-?\d+\.)(?:e\d+)?/],
  ["identifier", /^\p{XID_Start}\p{XID_Continue}*/u],
  ["integer", /^-?\d+/],
  ["newline", /^(?:\r\n|\r|\n)/],
  ["operator", /^(?:=>|==|<=|>=|[,+\-*/<>=()\[\]{};])/],
  ["string", /^(['"])((?:\\.|(?!\1).)*)\1/],
  ["whitespace", /^[ \t]+/],
] as const;

function main() {
  const src = fs.readFileSync(process.stdin.fd, "utf-8");
  const globals = {
    print: (x: unknown) => console.log(x),
    add: (a: number, b: number) => a + b,
    "+": (a: number, b: number) => a + b,
    "-": (a: number, b: number) => a - b,
    "*": (a: number, b: number) => a * b,
    "/": (a: number, b: number) => a / b,
    "<": (a: number, b: number) => a < b,
    "<=": (a: number, b: number) => a > b,
    ">": (a: number, b: number) => a > b,
    ">=": (a: number, b: number) => a >= b,
    "==": (a: number, b: number) => a === b,
    "!=": (a: number, b: number) => a !== b,
    if: (cond: boolean, then: () => void, else_: () => void) =>
      cond ? then() : else_(),
    push: (arr: unknown[], x: unknown) => arr.push(x),
    pop: (arr: unknown[]) => arr.pop(),
    get: (obj: object, k: string | number) => obj[k as keyof typeof obj],
    each: (arr: unknown[], fn: (x: unknown) => void) => arr.forEach(fn),
    range: (length: number) => Array.from({ length }, (_, i) => i),
  };

  try {
    run(src, { globals });
  } catch (e) {
    if (e instanceof ErrorWithSource) {
      console.error(e.message);
      debug(e.stack!);
      debug(JSON.stringify({ globals }, null, 2));
      process.exit(1);
    } else {
      throw e;
    }
  }
}

function run(src: string, { globals = {} } = {}) {
  const tokens = tokenize(src);
  debug("▒▒▒ tokens ▒▒▒");
  debug(() => tokens.map(formatToken).join("\n"));
  debug("▒▒▒ parsing ▒▒▒");
  const ast = parse({ tokens });
  debug("▒▒▒ AST ▒▒▒");
  debug(() => JSON.stringify(ast, (k, v) => (k === "loc" ? undefined : v), 2));
  debug("▒▒▒ evaling ▒▒▒");
  const result = evalNode(ast, { globals });
  debug(() => JSON.stringify({ globals }, null, 2));
  console.log(result);
}

type BaseToken = {
  type?: unknown;
  value?: unknown;
  src: string;
  start: number;
  length: number;
  line: number;
  col: number;
};

type Token = BaseToken &
  (
    | { type: "comment"; value: string }
    | { type: "identifier"; value: string }
    | { type: "literal"; value: boolean | number | bigint | string }
    | { type: "operator"; value: string }
    | { type: "arrow"; value: string }
    | { type: "assign"; value: string }
    | { type: "semicolon"; value: string }
    | { type: "bracket"; value: string }
  );

function getSourceLine(src: string, line: number): string {
  const result = src.split(/\r\n|\r|\n/g)[line - 1];
  if (result === undefined) {
    throw new Error(`internal error: line ${line} out of range`);
  }
  return result;
}

type ErrorWithSourceParams = {
  message?: string;
  src: string;
  line: number;
  col: number;
  length?: number;
};
class ErrorWithSource extends Error {
  args: ErrorWithSourceParams;

  constructor(args: ErrorWithSourceParams) {
    const lineCol = `line ${args.line}: `;
    const caret = `${" ".repeat(lineCol.length + args.col - 1)}\x1b[31m${"^".repeat(args.length ?? 1)}\x1b[0m`;
    super(dedent`
      ${args.message ?? "Error:"}
      ${lineCol}${getSourceLine(args.src, args.line)}
      ${caret}
    `);
    this.args = args;
  }
}

class UnexpectedTokenError extends ErrorWithSource {
  constructor({ message, ...rest }: ErrorWithSourceParams) {
    super({ message: message ?? "Unexpected token", ...rest });
  }
}

function tokenize(src: string): Token[] {
  const result: Token[] = [];
  let start = 0;
  let line = 1;
  let col = 1;

  while (start < src.length) {
    const matches = tokenPatterns.flatMap(([type, pattern]) => {
      const match = src.slice(start).match(pattern);
      if (match) return [{ type, match }];
      return [];
    });

    if (!matches[0]) {
      throw new UnexpectedTokenError({ src, line, col });
    }

    let longest = matches.reduce((longest, match) => {
      if (match.match[0].length > longest.match[0].length) return match;
      return longest;
    }, matches[0]);

    const length = longest.match[0].length;

    const base = {
      src,
      length,
      start,
      line,
      col,
    };

    start += length;
    col += length;

    switch (longest.type) {
      case "whitespace":
        break;
      case "newline": {
        line++;
        col = 1;
        break;
      }
      case "boolean": {
        result.push({
          ...base,
          type: "literal",
          value: longest.match[0] === "true",
        });
        break;
      }
      case "float": {
        result.push({
          ...base,
          type: "literal",
          value: Number.parseFloat(longest.match[0]),
        });
        break;
      }
      case "integer": {
        let value: number | bigint = Number.parseInt(longest.match[0]);
        if (value > Number.MAX_SAFE_INTEGER) {
          value = BigInt(longest.match[0]);
        }
        result.push({
          ...base,
          type: "literal",
          value,
        });
        break;
      }
      case "string": {
        const value = longest.match[2];
        if (typeof value !== "string") {
          throw new Error("internal error: string match group is not a string");
        }
        result.push({
          ...base,
          type: "literal",
          value,
        });
        break;
      }
      case "comment":
      case "identifier":
      case "operator": {
        result.push({
          ...base,
          type: longest.type,
          value: longest.match[0],
        });
        break;
      }
      default:
        impossible(longest.type, "Invalid token type");
    }
  }
  return result;
}

type NodeLocation = {
  src: string;
  start: number;
  length: number;
  line0: number;
  col0: number;
  line1: number;
  col1: number;
};

function nodeLocationFromToken(token: BaseToken): NodeLocation {
  return {
    src: token.src,
    start: token.start,
    length: token.length,
    line0: token.line,
    col0: token.col,
    line1: token.line,
    col1: token.col + token.length,
  };
}

function mergeNodeLocations(...locations: Array<NodeLocation>): NodeLocation {
  if (!locations[0]) {
    throw new Error(
      "internal error: mergeNodeLocations expects at least 1 location",
    );
  }
  return locations.reduce(
    (merged, loc) => {
      if (loc === null) return merged;
      return {
        src: merged.src,
        start: Math.min(merged.start, loc.start),
        length:
          Math.max(merged.start + merged.length, loc.start + loc.length) -
          Math.min(merged.start, loc.start),
        line0: Math.min(merged.line0, loc.line0),
        col0: Math.min(merged.col0, loc.col0),
        line1: Math.max(merged.line1, loc.line1),
        col1: Math.max(merged.col1, loc.col1),
      };
    },
    {
      ...locations[0],
    },
  );
}

type BaseNode = {
  type?: unknown;
  loc: NodeLocation;
};

type CommentNode = BaseNode & { type: "comment"; value: string };
type LiteralNode = BaseNode & {
  type: "literal";
  value: boolean | string | number | bigint;
};
type IdentifierNode = BaseNode & { type: "identifier"; name: string };
type OperatorNode = BaseNode & { type: "operator"; name: string };
type AssignmentNode = BaseNode & {
  type: "assignment";
  name: IdentifierNode;
  value: ASTNode;
};
type CallNode = BaseNode & {
  type: "call";
  name: IdentifierNode | OperatorNode;
  args: ASTNode[];
};
type FunctionNode = BaseNode & {
  type: "function";
  args: IdentifierNode[];
  body: ASTNode;
};
type StatementListNode = BaseNode & {
  type: "statementList";
  statements: ASTNode[];
};
type BlockNode = BaseNode & { type: "block"; body: StatementListNode };
type ListNode = BaseNode & { type: "list"; items: ExpressionNode[] };
type TermNode = CallNode | LiteralNode | IdentifierNode | BlockNode | ListNode;
type ExpressionNode = CommentNode | AssignmentNode | FunctionNode | TermNode;
type ASTNode = StatementListNode | ExpressionNode;

type ParseState = { tokens: Token[]; i: number };

class ParseError extends ErrorWithSource {
  constructor({ message, token }: { message: string; token: Token }) {
    super({
      message: message ?? "Parse error",
      line: token.line,
      col: token.col,
      src: token.src,
      length: token.length,
    });
  }
}

let txnDepth = 0;
function txn<S extends object, T>(
  debugName: string,
  state: S,
  fn: (state: S) => T,
): T {
  try {
    debug(`${"  ".repeat(txnDepth)}${debugName}`);
    ++txnDepth;
    const clonedState = Object.assign({}, state);
    const result = fn(clonedState);
    Object.assign(state, clonedState);
    return result;
  } finally {
    --txnDepth;
  }
}

function parse({ tokens }: { tokens: ParseState["tokens"] }): ASTNode {
  const state = { tokens, i: 0 };
  const result = parseStatementList(state);
  if (state.i < tokens.length) {
    throw new ParseError({
      message: "Unexpected token",
      token: tokens[state.i]!,
    });
  }
  return result;
}

function parseOneOf<
  TResult,
  TParsers extends Array<(state: ParseState) => TResult>,
>(state: ParseState, ...parsers: TParsers): TResult {
  return txn("parseOneOf", state, (state) => {
    const token = state.tokens[state.i];
    if (!token) {
      throw new ParseError({
        message: "Expected token before end of input",
        token: state.tokens[state.i - 1]!,
      });
    }
    for (const parse of parsers) {
      try {
        const result = parse(state);
        debug(`[parseOneOf] MATCHED ${parse.name}`);
        return result;
      } catch (e) {
        if (e instanceof ParseError) {
          continue;
        }
        throw e;
      }
    }
    const expectedTypes = parsers.map((parser) =>
      parser.name.replace(/^parse/, ""),
    );
    throw new ParseError({
      message: `Expected one of ${expectedTypes.join(", ")}`,
      token,
    });
  });
}

type TokenMatcher<TToken> = {
  [key in keyof TToken]?: TToken[key] extends string
    ? TToken[key] | RegExp
    : TToken[key];
};

type TokenMatcherByType<TType extends Token["type"]> = TokenMatcher<
  Extract<Token, { type: TType }>
>;

function takeToken<
  TType extends Token["type"],
  TResult = Extract<Token, { type: TType }>,
>({
  state,
  type,
  match,
}: {
  state: ParseState;
  type: TType;
  match?: TokenMatcherByType<TType>;
}): TResult {
  const token = state.tokens[state.i];
  if (!token) {
    throw new ParseError({
      message: "Expected token before end of input",
      token: state.tokens[state.i - 1]!,
    });
  }
  if (token.type !== type) {
    throw new ParseError({
      message: `Expected token with type ${type} but got ${token.type}`,
      token,
    });
  }
  if (match) {
    for (const key in match) {
      const tokenVal =
        key in token ? token[key as keyof typeof token] : undefined;

      const matcher = match[key as keyof typeof match];

      if (matcher instanceof RegExp) {
        if (typeof tokenVal !== "string" || !matcher.test(tokenVal)) {
          throw new ParseError({
            message: `Expected token with ${key} matching ${matcher} but got ${tokenVal}`,
            token,
          });
        }
      } else if (tokenVal !== matcher) {
        throw new ParseError({
          message: `Expected token with ${key}=${matcher} but got ${tokenVal}`,
          token,
        });
      }
    }
  }
  state.i += 1;
  return token as TResult;
}

function parseComment(
  state: ParseState,
  match?: TokenMatcherByType<"comment">,
): CommentNode {
  return txn(`parseComment ${JSON.stringify(match)}`, state, (state) => {
    const token = takeToken({ state, type: "comment", match });
    return {
      type: "comment",
      value: token.value,
      loc: nodeLocationFromToken(token),
    };
  });
}

function parseIdentifier(
  state: ParseState,
  match?: TokenMatcherByType<"identifier">,
): IdentifierNode {
  return txn(`parseIdentifier ${JSON.stringify(match)}`, state, (state) => {
    const token = takeToken({ state, type: "identifier", match });
    return {
      type: "identifier",
      name: token.value,
      loc: nodeLocationFromToken(token),
    };
  });
}

function parseOperator(
  state: ParseState,
  match?: TokenMatcherByType<"operator">,
): OperatorNode {
  return txn(`parseOperator ${JSON.stringify(match)}`, state, (state) => {
    const token = takeToken({ state, type: "operator", match });
    return {
      type: "operator",
      name: token.value,
      loc: nodeLocationFromToken(token),
    };
  });
}

function parseLiteral(
  state: ParseState,
  match?: TokenMatcherByType<"literal">,
): LiteralNode {
  return txn(`parseLiteral ${JSON.stringify(match)}`, state, (state) => {
    const token = takeToken({ state, type: "literal", match });
    return {
      type: "literal",
      value: token.value,
      loc: nodeLocationFromToken(token),
    };
  });
}

function parseAssignment(state: ParseState): AssignmentNode {
  return txn("parseAssignment", state, (state) => {
    const name = parseIdentifier(state);
    const assign = parseOperator(state, { value: "=" });
    const value = parseExpression(state);
    return {
      type: "assignment",
      name,
      value,
      loc: mergeNodeLocations(name.loc, assign.loc, value.loc),
    };
  });
}

function parseCall(state: ParseState): CallNode {
  return txn("parseCall", state, (state) => {
    const name = parseIdentifier(state);

    parseOperator(state, { value: "(" });

    const args: ASTNode[] = [];
    while (state.i < state.tokens.length) {
      try {
        args.push(parseExpression(state));
        parseOperator(state, { value: "," });
      } catch {
        debug("[parseCall] no comma after argument");
        break;
      }
    }

    const closingParen = parseOperator(state, { value: ")" });

    return {
      type: "call",
      name,
      args,
      loc: mergeNodeLocations(name.loc, closingParen.loc),
    };
  });
}

function parseLambda(state: ParseState): FunctionNode {
  return txn("parseLambda", state, (state) => {
    const openParen = parseOperator(state, { value: "(" });

    const args: IdentifierNode[] = [];
    while (state.i < state.tokens.length) {
      try {
        args.push(parseIdentifier(state));
        parseOperator(state, { value: "," });
      } catch {
        debug("[parseLambda] no comma after parameter");
        break;
      }
    }

    parseOperator(state, { value: ")" });
    parseOperator(state, { value: "=>" });

    const body = parseExpression(state);

    return {
      type: "function",
      args,
      body,
      loc: mergeNodeLocations(openParen.loc, body.loc),
    };
  });
}

function parseBlock(state: ParseState): BlockNode {
  return txn("parseBlock", state, (state) => {
    const openBrace = parseOperator(state, { value: "{" });
    const body = parseStatementList(state);
    const closeBrace = parseOperator(state, { value: "}" });
    return {
      type: "block",
      body,
      loc: mergeNodeLocations(openBrace.loc, closeBrace.loc),
    };
  });
}

function parseList(state: ParseState): ListNode {
  return txn("parseList", state, (state) => {
    const openBracket = parseOperator(state, { value: "[" });
    const items: ExpressionNode[] = [];
    while (state.i < state.tokens.length) {
      try {
        items.push(parseExpression(state));
        parseOperator(state, { value: "," });
      } catch {
        debug("[parseList] no comma after element");
        break;
      }
    }
    const closeBracket = parseOperator(state, { value: "]" });
    return {
      type: "list",
      items,
      loc: mergeNodeLocations(openBracket.loc, closeBracket.loc),
    };
  });
}

function parseTerm(state: ParseState): TermNode {
  return txn("parseTerm", state, (state) => {
    return parseOneOf(
      state,
      parseCall,
      parseBlock,
      parseList,
      parseLiteral,
      parseIdentifier,
    );
  });
}

function parseBinop(state: ParseState): CallNode {
  return txn("parseBinop", state, (state) => {
    const left = parseTerm(state);
    const name = parseOperator(state, { value: /^(?:==|<=|>=|[+\-*/<>])/ });
    const right = parseExpression(state);

    return {
      type: "call",
      name: {
        type: "identifier",
        name: name.name,
        loc: name.loc,
      },
      args: [left, right],
      loc: mergeNodeLocations(left.loc, right.loc),
    };
  });
}

function parseExpression(state: ParseState): ExpressionNode {
  return txn("parseExpression", state, (state) => {
    return parseOneOf(
      state,
      parseComment,
      parseAssignment,
      parseLambda,
      parseBinop,
      parseTerm,
    );
  });
}

function parseStatementList(state: ParseState): StatementListNode {
  return txn("parseStatementList", state, (state) => {
    const statements: ASTNode[] = [];
    while (state.i < state.tokens.length) {
      try {
        statements.push(parseExpression(state));
        parseOperator(state, { value: ";" });
      } catch (e) {
        if (e instanceof ParseError) {
          break;
        }
        throw e;
      }
    }

    let loc = {
      src: "<none>",
      start: 0,
      length: 0,
      col0: 0,
      col1: 0,
      line0: 0,
      line1: 0,
    };
    if (statements[0]) {
      loc = mergeNodeLocations(statements[0].loc, statements.at(-1)!.loc);
    }

    return {
      type: "statementList",
      statements,
      loc,
    };
  });
}

type EvalState = { globals: { [k: string]: unknown } };

class EvalError extends ErrorWithSource {
  constructor(message: string, node: ASTNode) {
    super({
      message,
      col: node.loc.col0,
      line: node.loc.line0,
      length: node.loc.length,
      src: node.loc.src,
    });
  }
}

function evalInclude(node: CallNode, state: EvalState): unknown {
  const pathNode = node.args[0];
  if (!pathNode) {
    throw new EvalError("include() requires a path argument", node);
  }
  const path = evalNode(pathNode, state);
  if (typeof path !== "string") {
    throw new EvalError("include() path argument must be a string", pathNode);
  }
  const src = fs.readFileSync(path, "utf-8");
  try {
    return evalNode(parse({ tokens: tokenize(src) }), state);
  } catch (e) {
    throw new EvalError(`Error in included file ${path}:\n${e}`, node);
  }
}

function evalNode(node: ASTNode, state: EvalState = { globals: {} }): unknown {
  switch (node.type) {
    case "comment":
      return undefined;
    case "assignment":
      return (state.globals[node.name.name] = evalNode(node.value, state));
    case "block":
      return evalNode(node.body, state);
    case "statementList":
      return node.statements.map((s) => evalNode(s, state)).at(-1);
    case "call":
      const name = node.name.name;
      if (name === "include") {
        return evalInclude(node, state);
      }
      const fn = state.globals[name];
      if (typeof fn !== "function") {
        throw new EvalError(`Cannot call non-function ${node.name.name}`, node);
      }
      return fn(...node.args.map((arg) => evalNode(arg, state)));
    case "function":
      return function lambda(...args: unknown[]) {
        return txn("function", state.globals, (globals) => {
          args.forEach((arg, i) => {
            const param = node.args[i];
            if (param) {
              globals[param.name] = arg;
            }
          });
          return evalNode(node.body, { globals });
        });
      };
    case "list":
      return node.items.map((item) => evalNode(item, state));
    case "identifier":
      return state.globals[node.name];
    case "literal":
      return node.value;
    default:
      impossible(node, "Invalid node type");
  }
}

function formatToken(token: BaseToken): string {
  return `{${token.line}:${token.col} ${token.type} ${token.value}}`;
}

function impossible(x: never, message: string): never {
  throw new Error(`Impossible state: ${message}`);
}

main();
