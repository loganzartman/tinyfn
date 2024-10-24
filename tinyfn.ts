import fs from "fs";
import process from "process";

const pattern = {
  whitespace: /\s/,
  startNumber: /[0-9]/,
  number: /[0-9_]/,
  startFraction: /\./,
  fraction: /[0-9_]/,
  startString: /["']/,
  string: /(?!\\)[^"']/,
  startComment: /#/,
  comment: /[^\r\n]/,
  startIdentifier: /[a-zA-Z_$]/,
  identifier: /[^\s#=(),:]/,
  operator: /[=(),:]/,
};

const src = `
a = 1
print(a)
b = 2
print(b)
print(add(a, b))
plus = (a, b) : add(a, b)
print(plus(a, b))
`;

function main() {
  // const src = fs.readFileSync(process.stdin.fd, "utf-8");
  run(src, {
    globals: {
      print: (x: unknown) => console.log(x),
      add: (a: number, b: number) => a + b,
    },
  });
}

function run(src: string, { globals = {} } = {}) {
  const tokens = tokenize(src);
  console.log({ tokens });
  const ast = parse({ tokens });
  console.log(JSON.stringify(ast, null, 2));
  const result = evalNode(ast, { globals });
  console.log({ result, globals });
}

type BaseToken = {
  src: string;
  start: number;
  end: number;
};

type Token = BaseToken &
  (
    | { type: "boolean"; value: boolean }
    | { type: "string"; value: string }
    | { type: "integer"; value: number }
    | { type: "bigint"; value: bigint }
    | { type: "float"; value: number }
    | { type: "identifier"; value: string }
    | { type: "operator"; value: string }
    | { type: "comment"; value: string }
  );

function tokenize(src: string): Token[] {
  const result: Token[] = [];
  let state = "none";
  let start = 0;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (state === "none") {
      if (pattern.whitespace.test(c)) {
        ++i;
        continue;
      }
      if (pattern.startNumber.test(c)) {
        state = "number";
        start = i;
        ++i;
        continue;
      }
      if (pattern.startString.test(c)) {
        state = "string";
        start = i;
        ++i;
        continue;
      }
      if (pattern.startComment.test(c)) {
        state = "comment";
        start = i;
        ++i;
        continue;
      }
      if (pattern.startIdentifier.test(c)) {
        state = "identifier";
        start = i;
        ++i;
        continue;
      }
      if (pattern.operator.test(c)) {
        result.push({
          type: "operator",
          value: c,
          src,
          start: i,
          end: i + 1,
        });
        ++i;
        continue;
      }
      throw new UnexpectedTokenError(src, i);
    } else if (state === "number") {
      if (pattern.number.test(c)) {
        ++i;
        continue;
      }
      if (pattern.startFraction.test(c)) {
        state = "fraction";
        ++i;
        continue;
      }
      let token: Token = {
        type: "integer",
        value: Number.parseInt(src.slice(start, i)),
        src,
        start,
        end: i,
      };
      if (token.value > Number.MAX_SAFE_INTEGER) {
        token = {
          type: "bigint",
          value: BigInt(src.slice(start, i)),
          src,
          start,
          end: i,
        };
      }
      if (Number.isNaN(token.value)) {
        throw new UnexpectedTokenError(src, i);
      }
      state = "none";
      result.push(token);
    } else if (state === "fraction") {
      if (pattern.fraction.test(c)) {
        ++i;
        continue;
      }
      const value = Number.parseFloat(src.slice(start, i));
      if (Number.isNaN(value)) {
        throw new UnexpectedTokenError(src, i);
      }
      state = "none";
      result.push({
        type: "float",
        value,
        src,
        start,
        end: i,
      });
    } else if (state === "string") {
      if (pattern.string.test(c)) {
        ++i;
        continue;
      }
      state = "none";
      result.push({
        type: "string",
        value: src.slice(start + 1, i),
        src,
        start,
        end: i,
      });
      ++i;
    } else if (state === "comment") {
      if (pattern.comment.test(c)) {
        ++i;
        continue;
      }
      state = "none";
      result.push({
        type: "comment",
        value: src.slice(start + 1, i),
        src,
        start,
        end: i,
      });
      ++i;
    } else if (state === "identifier") {
      if (pattern.identifier.test(c)) {
        ++i;
        continue;
      }
      state = "none";
      result.push({
        type: "identifier",
        value: src.slice(start, i),
        src,
        start,
        end: i,
      });
    } else {
      throw new Error(`Unknown state: ${state}`);
    }
  }

  return result;
}

type BlockNode = { type: "block"; body: ASTNode[] };
type LiteralNode = {
  type: "literal";
  value: boolean | string | number | bigint;
};
type IdentifierNode = { type: "identifier"; name: string };
type OperatorNode = { type: "operator"; name: string };
type AssignmentNode = {
  type: "assignment";
  name: IdentifierNode;
  value: ASTNode;
};
type CallNode = { type: "call"; name: IdentifierNode; args: ASTNode[] };
type FunctionNode = { type: "function"; args: IdentifierNode[]; body: ASTNode };
type ExpressionNode =
  | AssignmentNode
  | CallNode
  | FunctionNode
  | LiteralNode
  | IdentifierNode;
type ASTNode = BlockNode | ExpressionNode;

type ParseState = { tokens: Token[]; i: number };

function txn<S extends object, T>(state: S, fn: (state: S) => T): T {
  const clonedState = Object.assign({}, state);
  const result = fn(clonedState);
  Object.assign(state, clonedState);
  return result;
}

function parseIdentifier(
  state: ParseState,
  opts: { value?: string } = {},
): IdentifierNode {
  return txn(state, (state) => {
    const token = state.tokens[state.i++];
    if (!token) {
      throw new ParseError("Expected indentifier before end of input");
    }
    if (token.type !== "identifier") {
      throw new ParseError("Expected identifier", token);
    }
    if (opts.value !== undefined && token.value !== opts.value) {
      throw new ParseError(`Expected identifier ${opts.value}`, token);
    }
    return { type: "identifier", name: token.value };
  });
}

function parseOperator(
  state: ParseState,
  opts: { value?: string } = {},
): OperatorNode {
  return txn(state, (state) => {
    const token = state.tokens[state.i++];
    if (!token) {
      throw new ParseError("Expected operator before end of input");
    }
    if (token.type !== "operator") {
      throw new ParseError("Expected operator", token);
    }
    if (opts.value !== undefined && token.value !== opts.value) {
      throw new ParseError(`Expected operator ${opts.value}`, token);
    }
    return { type: "operator", name: token.value };
  });
}

function parseLiteral(
  state: ParseState,
  opts: { value?: boolean | number | bigint | string } = {},
): LiteralNode {
  return txn(state, (state) => {
    const token = state.tokens[state.i++];
    if (!token) {
      throw new ParseError("Expected literal before end of input");
    }
    if (!["boolean", "integer", "float", "string"].includes(token.type)) {
      throw new ParseError("Expected literal", token);
    }
    if (opts.value !== undefined && token.value !== opts.value) {
      throw new ParseError(`Expected literal with value ${opts.value}`, token);
    }
    return { type: "literal", value: token.value };
  });
}

function parseAssignment(state: ParseState): AssignmentNode {
  return txn(state, (state) => {
    const name = parseIdentifier(state);
    parseOperator(state, { value: "=" });
    const value = parseExpression(state);
    return {
      type: "assignment",
      name,
      value,
    };
  });
}

function parseCall(state: ParseState): CallNode {
  return txn(state, (state) => {
    const name = parseIdentifier(state);

    parseOperator(state, { value: "(" });

    const args: ASTNode[] = [];
    while (state.i < state.tokens.length) {
      try {
        args.push(parseExpression(state));
        parseOperator(state, { value: "," });
      } catch {
        break;
      }
    }

    parseOperator(state, { value: ")" });

    return {
      type: "call",
      name,
      args,
    };
  });
}

function parseLambda(state: ParseState): FunctionNode {
  return txn(state, (state) => {
    parseOperator(state, { value: "(" });

    const args: IdentifierNode[] = [];
    while (state.i < state.tokens.length) {
      try {
        args.push(parseIdentifier(state));
        parseOperator(state, { value: "," });
      } catch {
        break;
      }
    }

    parseOperator(state, { value: ")" });
    parseOperator(state, { value: ":" });

    const body = parseExpression(state);

    return {
      type: "function",
      args,
      body,
    };
  });
}

function parseExpression(state: ParseState): ExpressionNode {
  return txn(state, (state) => {
    try {
      return parseAssignment(state);
    } catch {}

    try {
      return parseCall(state);
    } catch {}

    try {
      return parseLambda(state);
    } catch {}

    try {
      return parseIdentifier(state);
    } catch {}

    try {
      return parseLiteral(state);
    } catch {}

    throw new ParseError("Expected expression", state.tokens[state.i]);
  });
}

function parseBlock(state: ParseState): BlockNode {
  return txn(state, (state) => {
    const body: ASTNode[] = [];
    while (state.i < state.tokens.length) {
      body.push(parseExpression(state));
    }

    return {
      type: "block",
      body,
    };
  });
}

function parse({ tokens }: { tokens: ParseState["tokens"] }): ASTNode {
  return parseBlock({ tokens, i: 0 });
}

type EvalState = { globals: { [k: string]: unknown } };

function evalNode(node: ASTNode, state: EvalState = { globals: {} }): unknown {
  switch (node.type) {
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
      throw new EvalError(`Cannot eval node of type ${node.type}`, node);
  }
}

class UnexpectedTokenError extends Error {
  constructor(src: string, index: number) {
    super(`Unexpected token at ${index}: ${src.slice(index)}`);
  }
}

class ParseError extends Error {
  constructor(message: string, token?: BaseToken) {
    if (!token) {
      super(`Parse error: ${message}`);
    } else {
      super(
        `Parse error at ${token.start}: ${message}\n${token.src.slice(token.start, token.end)}`,
      );
    }
  }
}

class EvalError extends Error {
  constructor(message: string, node: ASTNode) {
    super(`Eval error at ${JSON.stringify(node)}: ${message}`);
  }
}

main();
