// ============================================================
// TonScript AST — TypeScript-like syntax for TON smart contracts
// ============================================================

export type Position = { line: number; col: number };

// Top-level declarations
export type Program = {
  kind: "Program";
  declarations: Declaration[];
};

export type Declaration = ContractDecl | MessageDecl;

export type ContractDecl = {
  kind: "ContractDecl";
  name: string;
  fields: FieldDecl[];
  init?: InitDecl;
  receivers: ReceiveDecl[];
  getters: GetterDecl[];
  methods: MethodDecl[];
  pos: Position;
};

export type MessageDecl = {
  kind: "MessageDecl";
  name: string;
  opcode?: number; // explicit opcode override
  fields: FieldDecl[];
  pos: Position;
};

export type FieldDecl = {
  kind: "FieldDecl";
  name: string;
  type: TypeExpr;
  defaultValue?: Expr;
  pos: Position;
};

export type InitDecl = {
  kind: "InitDecl";
  params: ParamDecl[];
  body: Block;
  pos: Position;
};

export type ReceiveDecl = {
  kind: "ReceiveDecl";
  param: ParamDecl;
  body: Block;
  pos: Position;
};

export type GetterDecl = {
  kind: "GetterDecl";
  name: string;
  params: ParamDecl[];
  returnType?: TypeExpr;
  body: Block;
  pos: Position;
};

export type MethodDecl = {
  kind: "MethodDecl";
  name: string;
  params: ParamDecl[];
  returnType?: TypeExpr;
  body: Block;
  pos: Position;
};

export type ParamDecl = {
  kind: "ParamDecl";
  name: string;
  type: TypeExpr;
  pos: Position;
};

// Types
export type TypeExpr =
  | { kind: "IntType"; bits: number; signed: boolean }
  | { kind: "BoolType" }
  | { kind: "AddressType" }
  | { kind: "CoinsType" }
  | { kind: "CellType" }
  | { kind: "SliceType" }
  | { kind: "BuilderType" }
  | { kind: "StringType" }
  | { kind: "MapType"; keyType: TypeExpr; valueType: TypeExpr }
  | { kind: "NamedType"; name: string };

// Statements
export type Block = {
  kind: "Block";
  stmts: Stmt[];
  pos: Position;
};

export type Stmt =
  | LetStmt
  | ReturnStmt
  | IfStmt
  | WhileStmt
  | ForStmt
  | ExprStmt
  | AssignStmt;

export type LetStmt = {
  kind: "LetStmt";
  name: string;
  type?: TypeExpr;
  value: Expr;
  pos: Position;
};

export type ReturnStmt = {
  kind: "ReturnStmt";
  value?: Expr;
  pos: Position;
};

export type IfStmt = {
  kind: "IfStmt";
  condition: Expr;
  then: Block;
  else_?: Block | IfStmt;
  pos: Position;
};

export type WhileStmt = {
  kind: "WhileStmt";
  condition: Expr;
  body: Block;
  pos: Position;
};

export type ForStmt = {
  kind: "ForStmt";
  init: LetStmt | AssignStmt;
  condition: Expr;
  update: AssignStmt;
  body: Block;
  pos: Position;
};

export type ExprStmt = {
  kind: "ExprStmt";
  expr: Expr;
  pos: Position;
};

export type AssignStmt = {
  kind: "AssignStmt";
  target: LValue;
  op: "=" | "+=" | "-=" | "*=";
  value: Expr;
  pos: Position;
};

export type LValue =
  | { kind: "FieldAccess"; object: "this"; field: string }
  | { kind: "VarAccess"; name: string };

// Expressions
export type Expr =
  | NumberLit
  | BoolLit
  | StringLit
  | NullLit
  | Ident
  | ThisFieldExpr
  | MemberExpr
  | BinaryExpr
  | UnaryExpr
  | CallExpr
  | StructLitExpr;

export type NumberLit = {
  kind: "NumberLit";
  value: bigint;
  pos: Position;
};

export type BoolLit = {
  kind: "BoolLit";
  value: boolean;
  pos: Position;
};

export type StringLit = {
  kind: "StringLit";
  value: string;
  pos: Position;
};

export type NullLit = {
  kind: "NullLit";
  pos: Position;
};

export type Ident = {
  kind: "Ident";
  name: string;
  pos: Position;
};

export type ThisFieldExpr = {
  kind: "ThisFieldExpr";
  field: string;
  pos: Position;
};

export type MemberExpr = {
  kind: "MemberExpr";
  object: string;
  field: string;
  pos: Position;
};

export type BinaryExpr = {
  kind: "BinaryExpr";
  op: BinaryOp;
  left: Expr;
  right: Expr;
  pos: Position;
};

export type UnaryExpr = {
  kind: "UnaryExpr";
  op: "!" | "-";
  operand: Expr;
  pos: Position;
};

export type CallExpr = {
  kind: "CallExpr";
  callee: string;
  args: Expr[];
  pos: Position;
};

export type StructLitExpr = {
  kind: "StructLitExpr";
  name: string;
  fields: { name: string; value: Expr }[];
  pos: Position;
};

export type BinaryOp =
  | "+" | "-" | "*" | "/" | "%"
  | "==" | "!=" | "<" | ">" | "<=" | ">="
  | "&&" | "||"
  | "&" | "|" | "^"
  | "<<" | ">>";
