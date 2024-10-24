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
  identifier: /[^\s#()]/,
  operator: /[=(),]/,
};

function main() {
  const src = fs.readFileSync(process.stdin.fd, "utf-8");
  run(src);
}

function run(src: string) {
  const tokens = tokenize(src);
  console.log({ tokens });
  const ast = parse({ tokens });
  console.log(JSON.stringify(ast, null, 2));
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
type IdentifierNode = { type: "identifier"; value: string };
type OperatorNode = { type: "operator"; value: string };
type AssignmentNode = {
  type: "assignment";
  name: IdentifierNode;
  value: ASTNode;
};
type CallNode = { type: "call"; name: IdentifierNode; args: ASTNode[] };
type ExpressionNode = AssignmentNode | CallNode | LiteralNode | IdentifierNode;
type ASTNode = BlockNode | ExpressionNode;

type ParseState = { tokens: Token[]; i: number };

function txn<T>(state: ParseState, fn: (state: ParseState) => T): T {
  const clonedState: ParseState = { tokens: state.tokens, i: state.i };
  const result = fn(clonedState);
  state.tokens = clonedState.tokens;
  state.i = clonedState.i;
  return result;
}

function parseIdentifier(
  state: ParseState,
  opts: { value?: string } = {},
): IdentifierNode {
  return txn(state, (state) => {
    const token = state.tokens[state.i++];
    if (token.type !== "identifier") {
      throw new ParseError("Expected identifier", token);
    }
    if (opts.value !== undefined && token.value !== opts.value) {
      throw new ParseError(`Expected identifier ${opts.value}`, token);
    }
    return { type: "identifier", value: token.value };
  });
}

function parseOperator(
  state: ParseState,
  opts: { value?: string } = {},
): OperatorNode {
  return txn(state, (state) => {
    const token = state.tokens[state.i++];
    if (token.type !== "operator") {
      throw new ParseError("Expected operator", token);
    }
    if (opts.value !== undefined && token.value !== opts.value) {
      throw new ParseError(`Expected operator ${opts.value}`, token);
    }
    return { type: "operator", value: token.value };
  });
}

function parseLiteral(
  state: ParseState,
  opts: { value?: boolean | number | bigint | string } = {},
): LiteralNode {
  return txn(state, (state) => {
    const token = state.tokens[state.i++];
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
      } catch {}
    }

    parseOperator(state, { value: ")" });

    return {
      type: "call",
      name,
      args,
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
      try {
        body.push(parseExpression(state));
        continue;
      } catch {}

      throw new ParseError("Expected expression", state.tokens[state.i]);
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

class UnexpectedTokenError extends Error {
  constructor(src: string, index: number) {
    super(`Unexpected token at ${index}: ${src.slice(index)}`);
  }
}

class ParseError extends Error {
  constructor(message: string, token: BaseToken) {
    super(
      `Parse error at ${token.start}: ${message}\n${token.src.slice(token.start, token.end)}`,
    );
  }
}

main();
