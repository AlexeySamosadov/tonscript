// ============================================================
// TonScript Parser — Recursive Descent
// ============================================================

import { Lexer, Token, TokenKind } from "./lexer.js";
import * as AST from "./ast.js";

class ParseError extends Error {
  constructor(msg: string, public token: Token) {
    super(`[${token.line}:${token.col}] ${msg} (got '${token.value}')`);
  }
}

export class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = new Lexer(source).tokenize();
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? this.tokens[this.tokens.length - 1];
  }

  private advance(): Token {
    const tok = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos++;
    return tok;
  }

  private expect(kind: TokenKind, msg?: string): Token {
    const tok = this.peek();
    if (tok.kind !== kind) {
      throw new ParseError(msg ?? `Expected ${TokenKind[kind]}`, tok);
    }
    return this.advance();
  }

  private match(kind: TokenKind): boolean {
    if (this.peek().kind === kind) {
      this.advance();
      return true;
    }
    return false;
  }

  private at(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  private pos_(): AST.Position {
    const t = this.peek();
    return { line: t.line, col: t.col };
  }

  // ── Program ──────────────────────────────────────────────

  parse(): AST.Program {
    const declarations: AST.Declaration[] = [];
    while (!this.at(TokenKind.EOF)) {
      if (this.at(TokenKind.Contract)) {
        declarations.push(this.parseContract());
      } else if (this.at(TokenKind.Message)) {
        declarations.push(this.parseMessage());
      } else {
        throw new ParseError("Expected 'contract' or 'message'", this.peek());
      }
    }
    return { kind: "Program", declarations };
  }

  // ── Contract ─────────────────────────────────────────────

  private parseContract(): AST.ContractDecl {
    const pos = this.pos_();
    this.expect(TokenKind.Contract);
    const name = this.expect(TokenKind.Ident).value;
    this.expect(TokenKind.LBrace);

    const fields: AST.FieldDecl[] = [];
    let init: AST.InitDecl | undefined;
    const receivers: AST.ReceiveDecl[] = [];
    const getters: AST.GetterDecl[] = [];
    const methods: AST.MethodDecl[] = [];

    while (!this.at(TokenKind.RBrace) && !this.at(TokenKind.EOF)) {
      if (this.at(TokenKind.Init)) {
        init = this.parseInit();
      } else if (this.at(TokenKind.Receive)) {
        receivers.push(this.parseReceive());
      } else if (this.at(TokenKind.Get)) {
        getters.push(this.parseGetter());
      } else if (this.at(TokenKind.Fn)) {
        methods.push(this.parseMethod());
      } else {
        // Try to parse as field
        fields.push(this.parseField());
      }
    }

    this.expect(TokenKind.RBrace);
    return { kind: "ContractDecl", name, fields, init, receivers, getters, methods, pos };
  }

  // ── Message ──────────────────────────────────────────────

  private parseMessage(): AST.MessageDecl {
    const pos = this.pos_();
    this.expect(TokenKind.Message);

    let opcode: number | undefined;
    // message(0x1234) Name { ... }
    if (this.at(TokenKind.LParen)) {
      this.advance();
      const opcodeToken = this.expect(TokenKind.Number);
      opcode = Number(opcodeToken.value);
      this.expect(TokenKind.RParen);
    }

    const name = this.expect(TokenKind.Ident).value;
    this.expect(TokenKind.LBrace);

    const fields: AST.FieldDecl[] = [];
    while (!this.at(TokenKind.RBrace) && !this.at(TokenKind.EOF)) {
      fields.push(this.parseField());
    }
    this.expect(TokenKind.RBrace);

    return { kind: "MessageDecl", name, opcode, fields, pos };
  }

  // ── Field ────────────────────────────────────────────────

  private parseField(): AST.FieldDecl {
    const pos = this.pos_();
    const name = this.expect(TokenKind.Ident).value;
    this.expect(TokenKind.Colon);
    const type = this.parseType();
    let defaultValue: AST.Expr | undefined;
    if (this.match(TokenKind.Eq)) {
      defaultValue = this.parseExpr();
    }
    this.match(TokenKind.Semi); // optional semicolon
    return { kind: "FieldDecl", name, type, defaultValue, pos };
  }

  // ── Init ─────────────────────────────────────────────────

  private parseInit(): AST.InitDecl {
    const pos = this.pos_();
    this.expect(TokenKind.Init);
    this.expect(TokenKind.LParen);
    const params = this.parseParamList();
    this.expect(TokenKind.RParen);
    const body = this.parseBlock();
    return { kind: "InitDecl", params, body, pos };
  }

  // ── Receive ──────────────────────────────────────────────

  private parseReceive(): AST.ReceiveDecl {
    const pos = this.pos_();
    this.expect(TokenKind.Receive);
    this.expect(TokenKind.LParen);
    const param = this.parseParam();
    this.expect(TokenKind.RParen);
    const body = this.parseBlock();
    return { kind: "ReceiveDecl", param, body, pos };
  }

  // ── Getter ───────────────────────────────────────────────

  private parseGetter(): AST.GetterDecl {
    const pos = this.pos_();
    this.expect(TokenKind.Get);
    const name = this.expect(TokenKind.Ident).value;
    this.expect(TokenKind.LParen);
    const params = this.parseParamList();
    this.expect(TokenKind.RParen);
    let returnType: AST.TypeExpr | undefined;
    if (this.match(TokenKind.Colon)) {
      returnType = this.parseType();
    }
    const body = this.parseBlock();
    return { kind: "GetterDecl", name, params, returnType, body, pos };
  }

  // ── Method ───────────────────────────────────────────────

  private parseMethod(): AST.MethodDecl {
    const pos = this.pos_();
    this.expect(TokenKind.Fn);
    const name = this.expect(TokenKind.Ident).value;
    this.expect(TokenKind.LParen);
    const params = this.parseParamList();
    this.expect(TokenKind.RParen);
    let returnType: AST.TypeExpr | undefined;
    if (this.match(TokenKind.Colon)) {
      returnType = this.parseType();
    }
    const body = this.parseBlock();
    return { kind: "MethodDecl", name, params, returnType, body, pos };
  }

  // ── Params ───────────────────────────────────────────────

  private parseParamList(): AST.ParamDecl[] {
    const params: AST.ParamDecl[] = [];
    if (!this.at(TokenKind.RParen)) {
      params.push(this.parseParam());
      while (this.match(TokenKind.Comma)) {
        params.push(this.parseParam());
      }
    }
    return params;
  }

  private parseParam(): AST.ParamDecl {
    const pos = this.pos_();
    const name = this.expect(TokenKind.Ident).value;
    this.expect(TokenKind.Colon);
    const type = this.parseType();
    return { kind: "ParamDecl", name, type, pos };
  }

  // ── Types ────────────────────────────────────────────────

  private parseType(): AST.TypeExpr {
    const tok = this.peek();

    // uint32, uint64, int256, etc.
    if (tok.kind === TokenKind.Ident && /^(uint|int)\d+$/.test(tok.value)) {
      this.advance();
      const signed = tok.value.startsWith("int");
      const bits = parseInt(tok.value.replace(/^(uint|int)/, ""));
      return { kind: "IntType", bits, signed };
    }

    if (tok.kind === TokenKind.Bool) { this.advance(); return { kind: "BoolType" }; }
    if (tok.kind === TokenKind.Address) { this.advance(); return { kind: "AddressType" }; }
    if (tok.kind === TokenKind.Coins) { this.advance(); return { kind: "CoinsType" }; }
    if (tok.kind === TokenKind.Cell) { this.advance(); return { kind: "CellType" }; }
    if (tok.kind === TokenKind.Slice) { this.advance(); return { kind: "SliceType" }; }
    if (tok.kind === TokenKind.Builder) { this.advance(); return { kind: "BuilderType" }; }

    // Map<K, V>
    if (tok.kind === TokenKind.Map) {
      this.advance();
      this.expect(TokenKind.Lt);
      const keyType = this.parseType();
      this.expect(TokenKind.Comma);
      const valueType = this.parseType();
      this.expect(TokenKind.Gt);
      return { kind: "MapType", keyType, valueType };
    }

    // Ident (Int, String, or message type name)
    if (tok.kind === TokenKind.Ident) {
      this.advance();
      if (tok.value === "Int") return { kind: "IntType", bits: 257, signed: true };
      if (tok.value === "String") return { kind: "StringType" };
      return { kind: "NamedType", name: tok.value };
    }

    throw new ParseError("Expected type", tok);
  }

  // ── Statements ───────────────────────────────────────────

  private parseBlock(): AST.Block {
    const pos = this.pos_();
    this.expect(TokenKind.LBrace);
    const stmts: AST.Stmt[] = [];
    while (!this.at(TokenKind.RBrace) && !this.at(TokenKind.EOF)) {
      stmts.push(this.parseStmt());
    }
    this.expect(TokenKind.RBrace);
    return { kind: "Block", stmts, pos };
  }

  private parseStmt(): AST.Stmt {
    if (this.at(TokenKind.Let) || this.at(TokenKind.Const)) {
      return this.parseLetStmt();
    }
    if (this.at(TokenKind.Return)) {
      return this.parseReturnStmt();
    }
    if (this.at(TokenKind.If)) {
      return this.parseIfStmt();
    }
    if (this.at(TokenKind.While)) {
      return this.parseWhileStmt();
    }
    if (this.at(TokenKind.For)) {
      return this.parseForStmt();
    }

    // Assignment or expression statement
    // Check for: this.field = ... or ident = ...
    return this.parseAssignOrExprStmt();
  }

  private parseLetStmt(): AST.LetStmt {
    const pos = this.pos_();
    this.advance(); // let/const
    const name = this.expect(TokenKind.Ident).value;
    let type: AST.TypeExpr | undefined;
    if (this.match(TokenKind.Colon)) {
      type = this.parseType();
    }
    this.expect(TokenKind.Eq);
    const value = this.parseExpr();
    this.match(TokenKind.Semi);
    return { kind: "LetStmt", name, type, value, pos };
  }

  private parseReturnStmt(): AST.ReturnStmt {
    const pos = this.pos_();
    this.advance(); // return
    let value: AST.Expr | undefined;
    if (!this.at(TokenKind.Semi) && !this.at(TokenKind.RBrace)) {
      value = this.parseExpr();
    }
    this.match(TokenKind.Semi);
    return { kind: "ReturnStmt", value, pos };
  }

  private parseIfStmt(): AST.IfStmt {
    const pos = this.pos_();
    this.expect(TokenKind.If);
    this.expect(TokenKind.LParen);
    const condition = this.parseExpr();
    this.expect(TokenKind.RParen);
    const then = this.parseBlock();

    let else_: AST.Block | AST.IfStmt | undefined;
    if (this.match(TokenKind.Else)) {
      if (this.at(TokenKind.If)) {
        else_ = this.parseIfStmt();
      } else {
        else_ = this.parseBlock();
      }
    }
    return { kind: "IfStmt", condition, then, else_, pos };
  }

  private parseWhileStmt(): AST.WhileStmt {
    const pos = this.pos_();
    this.expect(TokenKind.While);
    this.expect(TokenKind.LParen);
    const condition = this.parseExpr();
    this.expect(TokenKind.RParen);
    const body = this.parseBlock();
    return { kind: "WhileStmt", condition, body, pos };
  }

  private parseForStmt(): AST.ForStmt {
    const pos = this.pos_();
    this.expect(TokenKind.For);
    this.expect(TokenKind.LParen);

    // Init: let i = 0 or i = 0
    let init: AST.LetStmt | AST.AssignStmt;
    if (this.at(TokenKind.Let) || this.at(TokenKind.Const)) {
      init = this.parseLetStmt();
    } else {
      init = this.parseAssignOrExprStmt() as AST.AssignStmt;
    }
    // parseLetStmt/parseAssignOrExprStmt already consumed the semicolon

    // Condition: i < 10
    const condition = this.parseExpr();
    this.expect(TokenKind.Semi);

    // Update: i += 1
    const update = this.parseAssignOrExprStmt() as AST.AssignStmt;
    // No semicolon before RParen

    this.expect(TokenKind.RParen);
    const body = this.parseBlock();

    return { kind: "ForStmt", init, condition, update, body, pos };
  }

  private parseAssignOrExprStmt(): AST.Stmt {
    const pos = this.pos_();

    // Check for this.field assignment
    if (this.at(TokenKind.This)) {
      const saved = this.pos;
      this.advance(); // this
      if (this.match(TokenKind.Dot)) {
        const field = this.expect(TokenKind.Ident).value;
        const assignOps = [TokenKind.Eq, TokenKind.PlusEq, TokenKind.MinusEq, TokenKind.StarEq];
        for (const opKind of assignOps) {
          if (this.at(opKind)) {
            const opToken = this.advance();
            const op = opToken.value as AST.AssignStmt["op"];
            const value = this.parseExpr();
            this.match(TokenKind.Semi);
            return {
              kind: "AssignStmt",
              target: { kind: "FieldAccess", object: "this", field },
              op, value, pos,
            };
          }
        }
        // Not an assignment — backtrack and parse as expression
        this.pos = saved;
      } else {
        this.pos = saved;
      }
    }

    // Check for variable assignment
    if (this.at(TokenKind.Ident)) {
      const saved = this.pos;
      const name = this.advance().value;
      const assignOps = [TokenKind.Eq, TokenKind.PlusEq, TokenKind.MinusEq, TokenKind.StarEq];
      for (const opKind of assignOps) {
        if (this.at(opKind)) {
          const opToken = this.advance();
          const op = opToken.value as AST.AssignStmt["op"];
          const value = this.parseExpr();
          this.match(TokenKind.Semi);
          return {
            kind: "AssignStmt",
            target: { kind: "VarAccess", name },
            op, value, pos,
          };
        }
      }
      this.pos = saved;
    }

    // Expression statement
    const expr = this.parseExpr();
    this.match(TokenKind.Semi);
    return { kind: "ExprStmt", expr, pos };
  }

  // ── Expressions (precedence climbing) ────────────────────

  private parseExpr(): AST.Expr {
    return this.parseLogicalOr();
  }

  private parseLogicalOr(): AST.Expr {
    let left = this.parseLogicalAnd();
    while (this.at(TokenKind.PipePipe)) {
      const pos = this.pos_();
      this.advance();
      const right = this.parseLogicalAnd();
      left = { kind: "BinaryExpr", op: "||", left, right, pos };
    }
    return left;
  }

  private parseLogicalAnd(): AST.Expr {
    let left = this.parseBitwiseOr();
    while (this.at(TokenKind.AmpAmp)) {
      const pos = this.pos_();
      this.advance();
      const right = this.parseBitwiseOr();
      left = { kind: "BinaryExpr", op: "&&", left, right, pos };
    }
    return left;
  }

  private parseBitwiseOr(): AST.Expr {
    let left = this.parseBitwiseXor();
    while (this.at(TokenKind.Pipe)) {
      const pos = this.pos_();
      this.advance();
      const right = this.parseBitwiseXor();
      left = { kind: "BinaryExpr", op: "|", left, right, pos };
    }
    return left;
  }

  private parseBitwiseXor(): AST.Expr {
    let left = this.parseBitwiseAnd();
    while (this.at(TokenKind.Caret)) {
      const pos = this.pos_();
      this.advance();
      const right = this.parseBitwiseAnd();
      left = { kind: "BinaryExpr", op: "^", left, right, pos };
    }
    return left;
  }

  private parseBitwiseAnd(): AST.Expr {
    let left = this.parseEquality();
    while (this.at(TokenKind.Amp)) {
      const pos = this.pos_();
      this.advance();
      const right = this.parseEquality();
      left = { kind: "BinaryExpr", op: "&", left, right, pos };
    }
    return left;
  }

  private parseEquality(): AST.Expr {
    let left = this.parseComparison();
    while (this.at(TokenKind.EqEq) || this.at(TokenKind.BangEq)) {
      const pos = this.pos_();
      const op = this.advance().value as AST.BinaryOp;
      const right = this.parseComparison();
      left = { kind: "BinaryExpr", op, left, right, pos };
    }
    return left;
  }

  private parseComparison(): AST.Expr {
    let left = this.parseShift();
    while (this.at(TokenKind.Lt) || this.at(TokenKind.Gt) || this.at(TokenKind.LtEq) || this.at(TokenKind.GtEq)) {
      const pos = this.pos_();
      const op = this.advance().value as AST.BinaryOp;
      const right = this.parseShift();
      left = { kind: "BinaryExpr", op, left, right, pos };
    }
    return left;
  }

  private parseShift(): AST.Expr {
    let left = this.parseAddition();
    while (this.at(TokenKind.LtLt) || this.at(TokenKind.GtGt)) {
      const pos = this.pos_();
      const op = this.advance().value as AST.BinaryOp;
      const right = this.parseAddition();
      left = { kind: "BinaryExpr", op, left, right, pos };
    }
    return left;
  }

  private parseAddition(): AST.Expr {
    let left = this.parseMultiplication();
    while (this.at(TokenKind.Plus) || this.at(TokenKind.Minus)) {
      const pos = this.pos_();
      const op = this.advance().value as AST.BinaryOp;
      const right = this.parseMultiplication();
      left = { kind: "BinaryExpr", op, left, right, pos };
    }
    return left;
  }

  private parseMultiplication(): AST.Expr {
    let left = this.parseUnary();
    while (this.at(TokenKind.Star) || this.at(TokenKind.Slash) || this.at(TokenKind.Percent)) {
      const pos = this.pos_();
      const op = this.advance().value as AST.BinaryOp;
      const right = this.parseUnary();
      left = { kind: "BinaryExpr", op, left, right, pos };
    }
    return left;
  }

  private parseUnary(): AST.Expr {
    if (this.at(TokenKind.Bang) || this.at(TokenKind.Minus)) {
      const pos = this.pos_();
      const op = this.advance().value as "!" | "-";
      const operand = this.parseUnary();
      return { kind: "UnaryExpr", op, operand, pos };
    }
    return this.parseCallOrMember();
  }

  private parseCallOrMember(): AST.Expr {
    let expr = this.parsePrimary();

    while (true) {
      if (this.at(TokenKind.LParen) && expr.kind === "Ident") {
        const pos = this.pos_();
        this.advance();
        const args: AST.Expr[] = [];
        if (!this.at(TokenKind.RParen)) {
          args.push(this.parseExpr());
          while (this.match(TokenKind.Comma)) {
            args.push(this.parseExpr());
          }
        }
        this.expect(TokenKind.RParen);
        expr = { kind: "CallExpr", callee: expr.name, args, pos };
      } else if (this.at(TokenKind.Dot)) {
        const pos = this.pos_();
        this.advance();
        const field = this.expect(TokenKind.Ident).value;
        if (this.at(TokenKind.LParen)) {
          // Method call: expr.method(args)
          this.advance(); // consume '('
          const args: AST.Expr[] = [];
          if (!this.at(TokenKind.RParen)) {
            args.push(this.parseExpr());
            while (this.match(TokenKind.Comma)) {
              args.push(this.parseExpr());
            }
          }
          this.expect(TokenKind.RParen);
          expr = { kind: "MethodCallExpr", object: expr, method: field, args, pos };
        } else if (expr.kind === "Ident") {
          // Field access: ident.field (not followed by '(')
          expr = { kind: "MemberExpr", object: expr.name, field, pos: expr.pos };
        } else {
          // Field access on non-ident expression — wrap as MemberExpr is not possible
          // since MemberExpr.object is a string. Use MethodCallExpr with no args won't work.
          // For now, treat as a no-arg method call (getter-style).
          // This handles patterns like `expr.field` where expr is not a simple ident.
          expr = { kind: "MethodCallExpr", object: expr, method: field, args: [], pos };
        }
      } else {
        break;
      }
    }

    return expr;
  }

  private parsePrimary(): AST.Expr {
    const pos = this.pos_();
    const tok = this.peek();

    // Number
    if (tok.kind === TokenKind.Number) {
      this.advance();
      return { kind: "NumberLit", value: BigInt(tok.value), pos };
    }

    // String
    if (tok.kind === TokenKind.String) {
      this.advance();
      return { kind: "StringLit", value: tok.value, pos };
    }

    // Boolean
    if (tok.kind === TokenKind.True) {
      this.advance();
      return { kind: "BoolLit", value: true, pos };
    }
    if (tok.kind === TokenKind.False) {
      this.advance();
      return { kind: "BoolLit", value: false, pos };
    }

    // Null
    if (tok.kind === TokenKind.Null) {
      this.advance();
      return { kind: "NullLit", pos };
    }

    // sender()
    if (tok.kind === TokenKind.Sender) {
      this.advance();
      this.expect(TokenKind.LParen);
      this.expect(TokenKind.RParen);
      return { kind: "CallExpr", callee: "sender", args: [], pos };
    }

    // require(...)
    if (tok.kind === TokenKind.Require) {
      this.advance();
      this.expect(TokenKind.LParen);
      const args: AST.Expr[] = [];
      args.push(this.parseExpr());
      if (this.match(TokenKind.Comma)) {
        args.push(this.parseExpr());
      }
      this.expect(TokenKind.RParen);
      return { kind: "CallExpr", callee: "require", args, pos };
    }

    // send(...)
    if (tok.kind === TokenKind.Send) {
      this.advance();
      this.expect(TokenKind.LParen);
      const args: AST.Expr[] = [this.parseExpr()];
      this.expect(TokenKind.RParen);
      return { kind: "CallExpr", callee: "send", args, pos };
    }

    // this.field
    if (tok.kind === TokenKind.This) {
      this.advance();
      this.expect(TokenKind.Dot);
      const field = this.expect(TokenKind.Ident).value;
      return { kind: "ThisFieldExpr", field, pos };
    }

    // Parenthesized expression
    if (tok.kind === TokenKind.LParen) {
      this.advance();
      const expr = this.parseExpr();
      this.expect(TokenKind.RParen);
      return expr;
    }

    // Identifier (variable or struct literal)
    if (tok.kind === TokenKind.Ident) {
      this.advance();
      // Check for struct literal: Name { field: value, ... }
      if (this.at(TokenKind.LBrace)) {
        const saved = this.pos;
        this.advance(); // {
        // Disambiguate: if next is Ident followed by Colon, it's a struct literal
        if (this.at(TokenKind.Ident) && this.tokens[this.pos + 1]?.kind === TokenKind.Colon) {
          const fields: { name: string; value: AST.Expr }[] = [];
          while (!this.at(TokenKind.RBrace) && !this.at(TokenKind.EOF)) {
            const fname = this.expect(TokenKind.Ident).value;
            this.expect(TokenKind.Colon);
            const fvalue = this.parseExpr();
            fields.push({ name: fname, value: fvalue });
            if (!this.match(TokenKind.Comma)) break;
          }
          this.expect(TokenKind.RBrace);
          return { kind: "StructLitExpr", name: tok.value, fields, pos };
        }
        // Not a struct literal, backtrack
        this.pos = saved;
      }
      return { kind: "Ident", name: tok.value, pos };
    }

    throw new ParseError("Expected expression", tok);
  }
}
