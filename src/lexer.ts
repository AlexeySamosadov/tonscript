// ============================================================
// TonScript Lexer
// ============================================================

export enum TokenKind {
  // Literals
  Number, String, True, False, Null,
  // Identifiers & Keywords
  Ident, Contract, Message, Init, Receive, Get, Fn,
  Let, Const, Return, If, Else, While, For,
  This, Require, Send, Sender,
  // Types
  Bool, Address, Coins, Cell, Slice, Builder, Map,
  // Operators
  Plus, Minus, Star, Slash, Percent,
  Eq, EqEq, BangEq, Lt, Gt, LtEq, GtEq,
  AmpAmp, PipePipe, Bang,
  Amp, Pipe, Caret, Tilde, LtLt, GtGt,
  PlusEq, MinusEq, StarEq,
  Arrow,   // =>
  // Delimiters
  LParen, RParen, LBrace, RBrace, LBracket, RBracket,
  Comma, Semi, Colon, Dot, Question,
  // Special
  EOF, Error,
}

export type Token = {
  kind: TokenKind;
  value: string;
  line: number;
  col: number;
};

const KEYWORDS: Record<string, TokenKind> = {
  contract: TokenKind.Contract,
  message: TokenKind.Message,
  init: TokenKind.Init,
  receive: TokenKind.Receive,
  get: TokenKind.Get,
  fn: TokenKind.Fn,
  let: TokenKind.Let,
  const: TokenKind.Const,
  return: TokenKind.Return,
  if: TokenKind.If,
  else: TokenKind.Else,
  while: TokenKind.While,
  for: TokenKind.For,
  this: TokenKind.This,
  require: TokenKind.Require,
  send: TokenKind.Send,
  sender: TokenKind.Sender,
  true: TokenKind.True,
  false: TokenKind.False,
  null: TokenKind.Null,
  Bool: TokenKind.Bool,
  Address: TokenKind.Address,
  Coins: TokenKind.Coins,
  Cell: TokenKind.Cell,
  Slice: TokenKind.Slice,
  Builder: TokenKind.Builder,
  Map: TokenKind.Map,
};

export class Lexer {
  private src: string;
  private pos = 0;
  private line = 1;
  private col = 1;

  constructor(source: string) {
    this.src = source;
  }

  private peek(): string {
    return this.pos < this.src.length ? this.src[this.pos] : "\0";
  }

  private advance(): string {
    const ch = this.src[this.pos++];
    if (ch === "\n") {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return ch;
  }

  private skipWhitespaceAndComments() {
    while (this.pos < this.src.length) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        this.advance();
      } else if (ch === "/" && this.src[this.pos + 1] === "/") {
        // Line comment
        while (this.pos < this.src.length && this.peek() !== "\n") {
          this.advance();
        }
      } else if (ch === "/" && this.src[this.pos + 1] === "*") {
        // Block comment
        this.advance(); this.advance();
        while (this.pos < this.src.length) {
          if (this.peek() === "*" && this.src[this.pos + 1] === "/") {
            this.advance(); this.advance();
            break;
          }
          this.advance();
        }
      } else {
        break;
      }
    }
  }

  private readNumber(): Token {
    const startLine = this.line, startCol = this.col;
    let value = "";

    if (this.peek() === "0" && (this.src[this.pos + 1] === "x" || this.src[this.pos + 1] === "X")) {
      value += this.advance(); // 0
      value += this.advance(); // x
      while (this.pos < this.src.length && /[0-9a-fA-F_]/.test(this.peek())) {
        const ch = this.advance();
        if (ch !== "_") value += ch;
      }
    } else {
      while (this.pos < this.src.length && /[0-9_]/.test(this.peek())) {
        const ch = this.advance();
        if (ch !== "_") value += ch;
      }
    }
    return { kind: TokenKind.Number, value, line: startLine, col: startCol };
  }

  private readString(): Token {
    const startLine = this.line, startCol = this.col;
    const quote = this.advance(); // opening quote
    let value = "";
    while (this.pos < this.src.length && this.peek() !== quote) {
      if (this.peek() === "\\") {
        this.advance();
        const esc = this.advance();
        switch (esc) {
          case "n": value += "\n"; break;
          case "t": value += "\t"; break;
          case "\\": value += "\\"; break;
          case '"': value += '"'; break;
          case "'": value += "'"; break;
          default: value += esc;
        }
      } else {
        value += this.advance();
      }
    }
    if (this.pos < this.src.length) this.advance(); // closing quote
    return { kind: TokenKind.String, value, line: startLine, col: startCol };
  }

  private readIdentOrKeyword(): Token {
    const startLine = this.line, startCol = this.col;
    let value = "";
    while (this.pos < this.src.length && /[a-zA-Z0-9_]/.test(this.peek())) {
      value += this.advance();
    }

    // Check for type keywords like uint32, int256
    if (/^(uint|int)\d+$/.test(value)) {
      return { kind: TokenKind.Ident, value, line: startLine, col: startCol };
    }

    const kw = KEYWORDS[value];
    if (kw !== undefined) {
      return { kind: kw, value, line: startLine, col: startCol };
    }
    return { kind: TokenKind.Ident, value, line: startLine, col: startCol };
  }

  nextToken(): Token {
    this.skipWhitespaceAndComments();

    if (this.pos >= this.src.length) {
      return { kind: TokenKind.EOF, value: "", line: this.line, col: this.col };
    }

    const startLine = this.line, startCol = this.col;
    const ch = this.peek();

    // Numbers
    if (/[0-9]/.test(ch)) return this.readNumber();

    // Strings
    if (ch === '"' || ch === "'") return this.readString();

    // Identifiers and keywords
    if (/[a-zA-Z_]/.test(ch)) return this.readIdentOrKeyword();

    // Operators and delimiters
    this.advance();
    switch (ch) {
      case "(": return { kind: TokenKind.LParen, value: ch, line: startLine, col: startCol };
      case ")": return { kind: TokenKind.RParen, value: ch, line: startLine, col: startCol };
      case "{": return { kind: TokenKind.LBrace, value: ch, line: startLine, col: startCol };
      case "}": return { kind: TokenKind.RBrace, value: ch, line: startLine, col: startCol };
      case "[": return { kind: TokenKind.LBracket, value: ch, line: startLine, col: startCol };
      case "]": return { kind: TokenKind.RBracket, value: ch, line: startLine, col: startCol };
      case ",": return { kind: TokenKind.Comma, value: ch, line: startLine, col: startCol };
      case ";": return { kind: TokenKind.Semi, value: ch, line: startLine, col: startCol };
      case ":": return { kind: TokenKind.Colon, value: ch, line: startLine, col: startCol };
      case ".": return { kind: TokenKind.Dot, value: ch, line: startLine, col: startCol };
      case "?": return { kind: TokenKind.Question, value: ch, line: startLine, col: startCol };
      case "~": return { kind: TokenKind.Tilde, value: ch, line: startLine, col: startCol };
      case "^": return { kind: TokenKind.Caret, value: ch, line: startLine, col: startCol };

      case "+":
        if (this.peek() === "=") { this.advance(); return { kind: TokenKind.PlusEq, value: "+=", line: startLine, col: startCol }; }
        return { kind: TokenKind.Plus, value: ch, line: startLine, col: startCol };
      case "-":
        if (this.peek() === "=") { this.advance(); return { kind: TokenKind.MinusEq, value: "-=", line: startLine, col: startCol }; }
        return { kind: TokenKind.Minus, value: ch, line: startLine, col: startCol };
      case "*":
        if (this.peek() === "=") { this.advance(); return { kind: TokenKind.StarEq, value: "*=", line: startLine, col: startCol }; }
        return { kind: TokenKind.Star, value: ch, line: startLine, col: startCol };
      case "/":
        return { kind: TokenKind.Slash, value: ch, line: startLine, col: startCol };
      case "%":
        return { kind: TokenKind.Percent, value: ch, line: startLine, col: startCol };

      case "=":
        if (this.peek() === "=") { this.advance(); return { kind: TokenKind.EqEq, value: "==", line: startLine, col: startCol }; }
        if (this.peek() === ">") { this.advance(); return { kind: TokenKind.Arrow, value: "=>", line: startLine, col: startCol }; }
        return { kind: TokenKind.Eq, value: ch, line: startLine, col: startCol };
      case "!":
        if (this.peek() === "=") { this.advance(); return { kind: TokenKind.BangEq, value: "!=", line: startLine, col: startCol }; }
        return { kind: TokenKind.Bang, value: ch, line: startLine, col: startCol };
      case "<":
        if (this.peek() === "=") { this.advance(); return { kind: TokenKind.LtEq, value: "<=", line: startLine, col: startCol }; }
        if (this.peek() === "<") { this.advance(); return { kind: TokenKind.LtLt, value: "<<", line: startLine, col: startCol }; }
        return { kind: TokenKind.Lt, value: ch, line: startLine, col: startCol };
      case ">":
        if (this.peek() === "=") { this.advance(); return { kind: TokenKind.GtEq, value: ">=", line: startLine, col: startCol }; }
        if (this.peek() === ">") { this.advance(); return { kind: TokenKind.GtGt, value: ">>", line: startLine, col: startCol }; }
        return { kind: TokenKind.Gt, value: ch, line: startLine, col: startCol };
      case "&":
        if (this.peek() === "&") { this.advance(); return { kind: TokenKind.AmpAmp, value: "&&", line: startLine, col: startCol }; }
        return { kind: TokenKind.Amp, value: ch, line: startLine, col: startCol };
      case "|":
        if (this.peek() === "|") { this.advance(); return { kind: TokenKind.PipePipe, value: "||", line: startLine, col: startCol }; }
        return { kind: TokenKind.Pipe, value: ch, line: startLine, col: startCol };

      default:
        return { kind: TokenKind.Error, value: ch, line: startLine, col: startCol };
    }
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];
    while (true) {
      const tok = this.nextToken();
      tokens.push(tok);
      if (tok.kind === TokenKind.EOF) break;
    }
    return tokens;
  }
}
