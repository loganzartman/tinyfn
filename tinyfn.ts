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
  ["newline", /^(?:\r\n|\r|\n)/],
  ["whitespace", /^[ \t]+/],
  ["boolean", /^(?:true|false)/],
  ["float", /^(?:[0-9]*\.[0-9]+|[0-9]+\.)/],
  ["integer", /^[0-9]+/],
  ["string", /^(['"])((?:\\.|(?!\1).)*)\1/],
  ["comment", /^#[^\r\n]*/],
  ["identifier", /^[a-zA-Z$_][a-zA-Z0-9$_]*/],
  ["operator", /^=>|[=(){},]/],
] as const;

function main() {
  const src = fs.readFileSync(process.stdin.fd, "utf-8");
  try {
    run(src, {
      globals: {
        print: (x: unknown) => console.log(x),
        add: (a: number, b: number) => a + b,
        lt: (a: number, b: number) => a < b,
        if: (cond: boolean, then: () => void, else_: () => void) =>
          cond ? then() : else_(),
      },
    });
  } catch (e) {
    if (e instanceof ErrorWithSource) {
      console.error(e.message);
      debug(e.stack!);
      process.exit(1);
    } else {
      throw e;
    }
  }
}

function run(src: string, { globals = {} } = {}) {
  const tokens = tokenize(src);
  debug("tokens");
  debug(() => tokens.map(formatToken).join("\n"));
  const ast = parse({ tokens });
  debug(() => JSON.stringify(ast, null, 2));
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
    | { type: "literal"; value: boolean | number | bigint | string }
    | { type: "identifier"; value: string }
    | { type: "operator"; value: string }
    | { type: "comment"; value: string }
  );

function getSourceLine(src: string, line: number): string {
  return src.split(/\r\n|\r|\n/g)[line - 1];
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
    const caret =
      " ".repeat(lineCol.length + args.col - 1) + "^".repeat(args.length ?? 1);
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

    if (!matches.length) {
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
      case "newline": {
        line++;
        col = 1;
        break;
      }
      case "comment": {
        result.push({
          ...base,
          type: "comment",
          value: longest.match[0],
        });
        break;
      }
      case "identifier": {
        result.push({
          ...base,
          type: "identifier",
          value: longest.match[0],
        });
        break;
      }
      case "operator": {
        result.push({
          ...base,
          type: "operator",
          value: longest.match[0],
        });
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
        result.push({
          ...base,
          type: "literal",
          value: longest.match[2],
        });
        break;
      }
      case "whitespace":
        break;
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
  if (locations.length === 0) {
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
  name: IdentifierNode;
  args: ASTNode[];
};
type FunctionNode = BaseNode & {
  type: "function";
  args: IdentifierNode[];
  body: ASTNode;
};
type BlockNode = BaseNode & { type: "block"; body: ASTNode[] };
type ExpressionNode =
  | CommentNode
  | AssignmentNode
  | CallNode
  | FunctionNode
  | LiteralNode
  | IdentifierNode
  | BlockNode;
type ASTNode = BlockNode | ExpressionNode;

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

function txn<S extends object, T>(state: S, fn: (state: S) => T): T {
  const clonedState = Object.assign({}, state);
  const result = fn(clonedState);
  Object.assign(state, clonedState);
  return result;
}

function parseComment(state: ParseState): CommentNode {
  return txn(state, (state) => {
    const token = state.tokens[state.i++];
    if (!token) {
      throw new ParseError({
        message: "Expected comment before end of input",
        token,
      });
    }
    if (token.type !== "comment") {
      throw new ParseError({ message: "Expected comment", token });
    }
    return {
      type: "comment",
      value: token.value,
      loc: nodeLocationFromToken(token),
    };
  });
}

function parseIdentifier(
  state: ParseState,
  opts: { value?: string } = {},
): IdentifierNode {
  return txn(state, (state) => {
    const token = state.tokens[state.i++];
    if (!token) {
      throw new ParseError({
        message: "Expected indentifier before end of input",
        token,
      });
    }
    if (token.type !== "identifier") {
      throw new ParseError({ message: "Expected identifier", token });
    }
    if (opts.value !== undefined && token.value !== opts.value) {
      throw new ParseError({
        message: `Expected identifier ${opts.value}`,
        token,
      });
    }
    return {
      type: "identifier",
      name: token.value,
      loc: nodeLocationFromToken(token),
    };
  });
}

function parseOperator(
  state: ParseState,
  opts: { value?: string } = {},
): OperatorNode {
  return txn(state, (state) => {
    const token = state.tokens[state.i++];
    if (!token) {
      throw new ParseError({
        message: "Expected operator before end of input",
        token,
      });
    }
    if (token.type !== "operator") {
      throw new ParseError({ message: "Expected operator", token });
    }
    if (opts.value !== undefined && token.value !== opts.value) {
      throw new ParseError({
        message: `Expected operator ${opts.value}`,
        token,
      });
    }
    return {
      type: "operator",
      name: token.value,
      loc: nodeLocationFromToken(token),
    };
  });
}

function parseLiteral(
  state: ParseState,
  opts: { value?: boolean | number | bigint | string } = {},
): LiteralNode {
  return txn(state, (state) => {
    const token = state.tokens[state.i++];
    if (!token) {
      throw new ParseError({
        message: "Expected literal before end of input",
        token,
      });
    }
    if (token.type !== "literal") {
      throw new ParseError({ message: "Expected literal", token });
    }
    if (opts.value !== undefined && token.value !== opts.value) {
      throw new ParseError({
        message: `Expected literal with value ${opts.value}`,
        token,
      });
    }
    return {
      type: "literal",
      value: token.value,
      loc: nodeLocationFromToken(token),
    };
  });
}

function parseAssignment(state: ParseState): AssignmentNode {
  return txn(state, (state) => {
    debug("parseAssignment");
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
  debug("parseCall");
  return txn(state, (state) => {
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
  debug("parseLambda");
  return txn(state, (state) => {
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

function parseBlockExpression(state: ParseState): BlockNode {
  return txn(state, (state) => {
    debug("parseBlockExpression");
    const openBrace = parseOperator(state, { value: "{" });
    const result = parseBlock(state);
    const closeBrace = parseOperator(state, { value: "}" });
    return {
      ...result,
      loc: mergeNodeLocations(openBrace.loc, closeBrace.loc),
    };
  });
}

function parseExpression(state: ParseState): ExpressionNode {
  return txn(state, (state) => {
    debug("parseExpression");
    try {
      return parseComment(state);
    } catch (e) {
      debug(`[parseExpression] not comment: ${(e as Error).message}`);
    }

    try {
      return parseBlockExpression(state);
    } catch (e) {
      debug(`[parseExpression] not block: ${(e as Error).message}`);
    }

    try {
      return parseAssignment(state);
    } catch (e) {
      debug(`[parseExpression] not assignment: ${(e as Error).message}`);
    }

    try {
      return parseLambda(state);
    } catch (e) {
      debug(`[parseExpression] not lambda: ${(e as Error).message}`);
    }

    try {
      return parseCall(state);
    } catch (e) {
      debug(`[parseExpression] not call: ${(e as Error).message}`);
    }

    try {
      return parseIdentifier(state);
    } catch (e) {
      debug(`[parseExpression] not identifier: ${(e as Error).message}`);
    }

    try {
      return parseLiteral(state);
    } catch (e) {
      debug(`[parseExpression] not literal: ${(e as Error).message}`);
    }

    throw new ParseError({
      message: "Expected expression",
      token: state.tokens[state.i],
    });
  });
}

function parseBlock(state: ParseState): BlockNode {
  return txn(state, (state) => {
    const body: ASTNode[] = [];
    while (state.i < state.tokens.length) {
      try {
        body.push(parseExpression(state));
      } catch (e) {
        debug(`[parseBlock] end of block: ${(e as Error).message}`);
        break;
      }
    }

    if (body.length > 0) {
      return {
        type: "block",
        body,
        loc: mergeNodeLocations(body[0].loc, body.at(-1)!.loc),
      };
    } else {
      return {
        type: "block",
        body: [],
        loc: {
          src: "<none>",
          start: 0,
          length: 0,
          col0: 0,
          col1: 0,
          line0: 0,
          line1: 0,
        },
      };
    }
  });
}

function parse({ tokens }: { tokens: ParseState["tokens"] }): ASTNode {
  return parseBlock({ tokens, i: 0 });
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

function evalNode(node: ASTNode, state: EvalState = { globals: {} }): unknown {
  switch (node.type) {
    case "comment":
      return undefined;
    case "assignment":
      return (state.globals[node.name.name] = evalNode(node.value, state));
    case "block":
      return node.body.map((statement) => evalNode(statement, state)).at(-1);
    case "call":
      const fn = state.globals[node.name.name];
      if (typeof fn !== "function") {
        throw new EvalError(`Cannot call non-function ${node.name.name}`, node);
      }
      return fn(...node.args.map((arg) => evalNode(arg, state)));
    case "function":
      return function lambda(...args: unknown[]) {
        const newGlobals = { ...state.globals };
        node.args.forEach((arg, i) => {
          newGlobals[arg.name] = args[i];
        });
        return evalNode(node.body, { globals: newGlobals });
      };
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
