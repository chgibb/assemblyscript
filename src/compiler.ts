import * as ts from "byots";
import * as Long from "long";

import { Profiler } from "./profiler";
import * as builtins from "./builtins";

import {
  createDiagnosticForNode,
  printDiagnostic
} from "./diagnostics";

import {
  WasmModule,
  WasmSignature,
  WasmStatement,
  WasmExpression,
  WasmType,
  WasmFunctionFlags,
  WasmFunction,
  WasmVariable,
  WasmConstant,
  WasmI32Expression,
  WasmI64Expression,
  WasmF32Expression,
  WasmF64Expression,
  WasmI32Operations,
  WasmI64Operations,
  WasmF32Operations,
  WasmF64Operations,
  BinaryenType,
  BinaryenFunction
} from "./wasm";

import {
  byteType,
  sbyteType,
  shortType,
  ushortType,
  intType,
  uintType,
  longType,
  ulongType,
  boolType,
  floatType,
  doubleType,
  uintptrType32,
  uintptrType64,
  voidType
} from "./types";

const MEM_MAX_32 = (1 << 16) - 1; // 65535 (pageSize) * 65535 (n) ^= 4GB

function isExport(node: ts.Node): boolean {
  if (node && node.modifiers)
    for (let i = 0, k = node.modifiers.length; i < k; ++i)
      if (node.modifiers[i].kind === ts.SyntaxKind.ExportKeyword)
        return true;
  return false;
}

function isImport(node: ts.Node): boolean {
  if (node && node.modifiers)
    for (let i = 0, k = node.modifiers.length; i < k; ++i)
      if (node.modifiers[i].kind === ts.SyntaxKind.DeclareKeyword)
        return true;
  return false;
}

function isStatic(node: ts.Node): boolean {
  return (node.modifierFlagsCache & ts.ModifierFlags.Static) !== 0
}

// Rule #1: This is a compiler, not an optimizer. Makes life a lot easier.

export class Compiler {
  program: ts.Program;
  checker: ts.TypeChecker;
  entryFile: ts.SourceFile;
  diagnostics: ts.DiagnosticCollection;
  uintptrSize: number;
  uintptrType: WasmType;
  module: WasmModule;
  signatures: { [key: string]: WasmSignature } = {};
  constants: { [key: string]: WasmConstant } = {};
  profiler = new Profiler();
  currentFunction: WasmFunction;
  currentLocals: { [key: string]: WasmVariable };
  currentBreakContextNumber = 0;
  currentBreakContextDepth = 0;

  static compile(filename: string): WasmModule {

    let program = ts.createProgram([ __dirname + "/../assembly.d.ts", filename ], {
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.None,
      noLib: true,
      experimentalDecorators: true,
      types: []
    });

    let compiler = new Compiler(program);

    // bail out if there were 'pre emit' errors
    let diagnostics = ts.getPreEmitDiagnostics(compiler.program);
    for (let i = 0, k = diagnostics.length; i < k; ++i) {
      printDiagnostic(diagnostics[i]);
      if (diagnostics[i].category === ts.DiagnosticCategory.Error)
        return null;
    }

    compiler.profiler.start("initialize");
    compiler.initialize();
    process.stderr.write("initialization took " + compiler.profiler.end("initialize").toFixed(3) + " ms\n");

    // bail out if there were initialization errors
    diagnostics = compiler.diagnostics.getDiagnostics();
    for (let i = 0, k = diagnostics.length; i < k; ++i)
      if (diagnostics[i].category === ts.DiagnosticCategory.Error)
        return null;

    compiler.profiler.start("compile");
    compiler.compile();
    process.stderr.write("compilation took " + compiler.profiler.end("compile").toFixed(3) + " ms\n");

    // bail out if there were compilation errors
    diagnostics = compiler.diagnostics.getDiagnostics();
    for (let i = 0, k = diagnostics.length; i < k; ++i)
      if (diagnostics[i].category === ts.DiagnosticCategory.Error)
        return null;

    return compiler.module;
  }

  constructor(program: ts.Program, uintptrSize = 4) {
    if (uintptrSize !== 4 && uintptrSize !== 8)
      throw Error("unsupported uintptrSize");

    this.program = program;
    this.checker = program.getDiagnosticsProducingTypeChecker();
    this.diagnostics = ts.createDiagnosticCollection();
    this.module = new WasmModule();
    this.uintptrSize = uintptrSize;
    this.uintptrType = uintptrSize === 4 ? uintptrType32 : uintptrType64;

    // the last non-declaration source file is assumed to be the entry file (TODO: does this work in all cases?)
    const sourceFiles = program.getSourceFiles();
    for (let i = sourceFiles.length - 1; i >= 0; --i) {
      if (sourceFiles[i].isDeclarationFile)
        continue;
      this.entryFile = sourceFiles[i];
      break;
    }
  }

  info(node: ts.Node, message: string, arg1?: string): void {
    const diagnostic = createDiagnosticForNode(node, ts.DiagnosticCategory.Message, message, arg1);
    this.diagnostics.add(diagnostic);
    printDiagnostic(diagnostic);
  }

  warn(node: ts.Node, message: string, arg1?: string): void {
    const diagnostic = createDiagnosticForNode(node, ts.DiagnosticCategory.Warning, message, arg1);
    this.diagnostics.add(diagnostic);
    printDiagnostic(diagnostic);
  }

  error(node: ts.Node, message: string, arg1?: string): void {
    const diagnostic = createDiagnosticForNode(node, ts.DiagnosticCategory.Error, message, arg1);
    this.diagnostics.add(diagnostic);
    printDiagnostic(diagnostic);
  }

  initialize(): void {
    const compiler = this;

    this.module.setMemory(256, MEM_MAX_32, "memory", []); // TODO: it seem that binaryen.js doesn't support importing memory yet

    const sourceFiles = this.program.getSourceFiles();
    for (let i = 0, k = sourceFiles.length, file; i < k; ++i) {

      if ((file = sourceFiles[i]).isDeclarationFile)
        continue;

      for (let i = 0, k = file.statements.length, statement; i < k; ++i) {
        switch ((statement = file.statements[i]).kind) {

          case ts.SyntaxKind.ImportDeclaration: // already handled
            break;

          case ts.SyntaxKind.VariableStatement:
            compiler.initializeVariable(<ts.VariableStatement>statement);
            break;

          case ts.SyntaxKind.FunctionDeclaration:
            compiler.initializeFunction(<ts.FunctionDeclaration>statement);
            break;

          case ts.SyntaxKind.ClassDeclaration:
            compiler.initializeClass(<ts.ClassDeclaration>statement);
            break;

          case ts.SyntaxKind.EnumDeclaration:
            compiler.initializeEnum(<ts.EnumDeclaration>statement);
            break;

          case ts.SyntaxKind.EndOfFileToken:
            break;

          default:
            throw Error("unsupported top-level node: " + ts.SyntaxKind[statement.kind]);
        }
      }
    }
  }

  initializeVariable(node: ts.VariableStatement): void {
    // TODO: it seems that binaryen.js does not support globals, yet
  }

  private _initializeFunction(node: ts.FunctionDeclaration | ts.MethodDeclaration, parent?: ts.ClassDeclaration): void {
    const name = node.symbol.name;
    const returnType = this.resolveType(<ts.TypeNode>node.type, true);

    if (node.typeParameters && node.typeParameters.length !== 0)
      this.error(node.typeParameters[0], "Type parameters are not supported yet");

    let parameterTypes: WasmType[];
    let signatureIdentifiers: string[]; // including return type
    let signatureTypes: BinaryenType[]; // excluding return type
    let locals: WasmVariable[];
    let index = 0;
    let flags = 0;

    if (parent && !isStatic(<ts.MethodDeclaration>node)) { // add implicit 'this' as the first argument

      parameterTypes = new Array(node.parameters.length + 1);
      signatureTypes = new Array(parameterTypes.length);
      signatureIdentifiers = new Array(parameterTypes.length + 1);
      locals = new Array(parameterTypes.length);

      const thisType = this.uintptrType; // TODO: underlyingType

      parameterTypes[0] = thisType;
      signatureTypes[0] = thisType.toBinaryenType(this.uintptrType);
      signatureIdentifiers[0] = thisType.toSignatureIdentifier(this.uintptrType);
      locals[0] = {
        name: "this",
        index: 0,
        type: thisType
      };

      flags |= WasmFunctionFlags.instance;

      index = 1;

    } else {

      parameterTypes = new Array(node.parameters.length);
      signatureIdentifiers = new Array(parameterTypes.length + 1);
      signatureTypes = new Array(parameterTypes.length);
      locals = new Array(parameterTypes.length);
      index = 0;
    }

    for (let i = 0, k = node.parameters.length; i < k; ++i) {
      const name = node.parameters[i].symbol.name;
      const type = this.resolveType(<ts.TypeNode>node.parameters[i].type);

      parameterTypes[index] = type;
      signatureTypes[index] = type.toBinaryenType(this.uintptrType);
      signatureIdentifiers[index] = type.toSignatureIdentifier(this.uintptrType);
      locals[index] = {
        name: name,
        index: index,
        type: type
      };

      ++index;
    }

    signatureIdentifiers[index] = returnType.toSignatureIdentifier(this.uintptrType);

    const signatureId = signatureIdentifiers.join("");
    let signature = this.signatures[signatureId];
    if (!signature)
      signature = this.signatures[signatureId] = this.module.addFunctionType(signatureId, returnType.toBinaryenType(this.uintptrType), signatureTypes);

    if (isExport(node) && node.getSourceFile() === this.entryFile)
      flags |= WasmFunctionFlags.export;

    if (isImport(node))
      flags |= WasmFunctionFlags.import;

    (<any>node).wasmFunction = <WasmFunction>{
      name: parent ? parent.symbol.name + "$" + name : name,
      flags: flags,
      parameterTypes: parameterTypes,
      returnType: returnType,
      locals: locals,
      signature: signature,
      signatureId: signatureId
    };
  }

  initializeFunction(node: ts.FunctionDeclaration): void {
    this._initializeFunction(node);
  }

  initializeClass(node: ts.ClassDeclaration): void {
    const name = node.symbol.name;

    if (node.typeParameters && node.typeParameters.length !== 0)
      this.error(node.typeParameters[0], "Type parameters are not supported yet");

    for (let i = 0, k = node.members.length; i < k; ++i) {
      const member = node.members[i];
      switch (member.kind) {

        case ts.SyntaxKind.MethodDeclaration:
          if (isExport(member))
            this.error(member, "Class methods cannot be exports");

          if (isImport(member))
            this.error(member, "Class methods cannot be imports");

          this._initializeFunction(<ts.MethodDeclaration>member, node);
          break;

        default:
          this.error(member, "Unsupported class member", ts.SyntaxKind[node.kind]);

      }
    }
  }

  initializeEnum(node: ts.EnumDeclaration): void {
    const enumName = node.symbol.name;

    for (let i = 0, k = node.members.length, member; i < k; ++i) {
      const name = enumName + "$" + node.members[i].symbol.name;
      const value = this.checker.getConstantValue(member);

      this.constants[name] = {
        name: name,
        type: intType,
        value: value
      };
    }
  }

  compile(): void {

    const sourceFiles = this.program.getSourceFiles();
    for (let i = 0, k = sourceFiles.length; i < k; ++i) {

      if (sourceFiles[i].isDeclarationFile)
        continue;

      const statements = sourceFiles[i].statements;
      for (let j = 0, l = statements.length, statement; j < l; ++j) {
        switch ((statement = statements[j]).kind) {

          case ts.SyntaxKind.VariableStatement:
            this.compileVariable(<ts.VariableStatement>statement);
            break;

          case ts.SyntaxKind.FunctionDeclaration:
            this.compileFunction(<ts.FunctionDeclaration>statement);
            break;

          case ts.SyntaxKind.ClassDeclaration:
            this.compileClass(<ts.ClassDeclaration>statement);
            break;

          // otherwise already reported by initialize
        }
      }
    }
  }

  compileVariable(node: ts.VariableStatement): void {
    // TODO
  }

  private _compileFunction(node: ts.FunctionDeclaration | ts.MethodDeclaration): BinaryenFunction {
    const wasmFunction: WasmFunction = (<any>node).wasmFunction;
    const body: WasmStatement[] = new Array(node.body.statements.length);
    const additionalLocals: BinaryenType[] = [];
    const compiler = this;

    this.currentFunction = wasmFunction;
    this.currentBreakContextNumber = 0;
    this.currentBreakContextDepth = 0;
    this.currentLocals = {};

    let bodyIndex = 0;
    let localIndex = 0;

    for (let i = 0, k = wasmFunction.locals.length; i < k; ++i) { // includes 'this'
      const local = wasmFunction.locals[i];
      this.currentLocals[local.name] = local;
      ++localIndex;
    }

    for (let i = 0, k = node.body.statements.length; i < k; ++i) {
      const stmt = compiler.compileStatement(node.body.statements[i], onVariable);
      if (stmt !== null)
        body[bodyIndex++] = stmt;
    }

    body.length = bodyIndex;

    function onVariable(node: ts.VariableDeclaration): number {
      const name = node.name.getText();
      const type = (<any>node).wasmType;

      if (compiler.currentLocals[name]) {

        compiler.error(node, "Local variable shadows another variable of the same name in a parent scope", name);

      } else {

        compiler.currentLocals[name] = {
          name: name,
          index: localIndex,
          type: type
        };
      }

      additionalLocals.push(type.toBinaryenType());

      return localIndex++;
    }

    return this.module.addFunction(wasmFunction.name, wasmFunction.signature, additionalLocals, this.module.block("", body));
  }

  compileFunction(node: ts.FunctionDeclaration): void {
    const wasmFunction = <WasmFunction>(<any>node).wasmFunction;
    const name = node.symbol.name;

    if ((wasmFunction.flags & WasmFunctionFlags.import) !== 0) {
      let moduleName: string;
      let baseName: string;

      var idx = name.indexOf("$");
      if (idx > 0) {
        moduleName = name.substring(0, idx);
        baseName = name.substring(idx + 1);
      } else {
        moduleName = "env";
        baseName = name;
      }

      this.module.addImport(name, moduleName, baseName, wasmFunction.signature);
      return;
    }

    const functionHandle = this._compileFunction(node);

    if ((node.modifierFlagsCache & ts.ModifierFlags.Export) !== 0)
      this.module.addExport(name, name);

    if (name === "start") {
      if (wasmFunction.parameterTypes.length === 0 && wasmFunction.returnType === voidType)
        this.module.setStart(functionHandle);
      // else - TODO: should this emit a warning?
    }
  }

  compileClass(node: ts.ClassDeclaration): void {
    for (let i = 0, k = node.members.length, member; i < k; ++i) {
      switch ((member = node.members[i]).kind) {

        case ts.SyntaxKind.MethodDeclaration:
          this._compileFunction(<ts.MethodDeclaration>member);
          break;

        // otherwise already reported by initialize
      }
    }
  }

  enterBreakContext(): void {
    if (this.currentBreakContextDepth === 0)
      ++this.currentBreakContextNumber;
    ++this.currentBreakContextDepth;
  }

  leaveBreakContext(): void {
    if (this.currentBreakContextDepth < 1)
      throw Error("unbalanced break context");
    --this.currentBreakContextDepth;
  }

  get currentBreakLabel(): string {
    return this.currentBreakContextNumber + "." + this.currentBreakContextDepth;
  }

  compileStatement(node: ts.Statement, onVariable: (node: ts.VariableDeclaration) => number): WasmStatement {
    const op = this.module;

    switch (node.kind) {

      case ts.SyntaxKind.VariableStatement:
      {
        const variableNode = <ts.VariableStatement>node;
        const initializers: WasmExpression[] = [];

        for (let i = 0, k = variableNode.declarationList.declarations.length; i < k; ++i) {
          const decl = variableNode.declarationList.declarations[i];
          const type = this.resolveType(decl.type);

          (<any>decl).wasmType = type;

          const index = onVariable(decl);
          if (decl.initializer)
            initializers.push(op.setLocal(index, this.compileExpression(decl.initializer, type)));
        }

        return initializers.length === 0 ? null
             : initializers.length === 1 ? initializers[0]
             : op.block("", initializers); // praise rule #1
      }

      case ts.SyntaxKind.IfStatement:
      {
        const ifNode = <ts.IfStatement>node;

        return op.if(
          this.convertValue(ifNode.expression, this.compileExpression(ifNode.expression, intType), (<any>ifNode.expression).wasmType, intType, true),
          this.compileStatement(ifNode.thenStatement, onVariable),
          ifNode.elseStatement ? this.compileStatement(ifNode.elseStatement, onVariable) : undefined
        );
      }

      // TODO: From a TS perspective, br_table probably isn't unconditionally ideal - is it?
      /* case ts.SyntaxKind.SwitchStatement:
      {
        const stmt = <ts.SwitchStatement>node;
        const blocks: WasmStatement[] = new Array(stmt.caseBlock.clauses.length);
        const labels: string[] = new Array(blocks.length);
        let hasDefault = false;
        stmt.caseBlock.clauses.forEach((clause, i) => {
          let label: string;
          if (clause.kind == ts.SyntaxKind.DefaultClause) {
            if (hasDefault)
              this.error(clause, "A switch statement cannot have multiple default branches");
            hasDefault = true;
            label = "default";
          } else {
            label = "case" + i;
          }
          labels[i] = label;
          blocks[i] = op.block(label, clause.statements.map(stmt => this.compileStatement(stmt)));
        });
        return op.block("break", [
          op.switch(labels, hasDefault ? "default" : "break", this.compileExpression(stmt.expression, intType))
        ].concat(blocks));
      } */

      case ts.SyntaxKind.WhileStatement:
      {
        const whileNode = <ts.WhileStatement>node;

        this.enterBreakContext();
        const label = this.currentBreakLabel;

        const context = op.loop("break$" + label, op.block("continue$" + label, [
          op.break("break$" + label, op.i32.eqz(this.convertValue(whileNode.expression, this.compileExpression(whileNode.expression, intType), (<any>whileNode.expression).wasmType, intType, true))),
          this.compileStatement(whileNode.statement, onVariable)
        ]));

        this.leaveBreakContext();
        return context;
      }

      case ts.SyntaxKind.DoStatement:
      {
        const doNode = <ts.WhileStatement>node;

        this.enterBreakContext();
        const label = this.currentBreakLabel;

        const context = op.loop("break$" + label, op.block("continue$" + label, [
          this.compileStatement(doNode.statement, onVariable),
          op.break("break$" + label, op.i32.eqz(this.convertValue(doNode.expression, this.compileExpression(doNode.expression, intType), (<any>doNode.expression).wasmType, intType, true)))
        ]));

        this.leaveBreakContext();
        return context;
      }

      case ts.SyntaxKind.Block:
      {
        const blockNode = <ts.Block>node;
        if (blockNode.statements.length === 0)
          return op.nop();
        else if (blockNode.statements.length === 1)
          return this.compileStatement(blockNode.statements[0], onVariable);
        else {
          const children: WasmStatement[] = new Array(blockNode.statements.length);
          for (let i = 0, k = children.length; i < k; ++i)
            children[i] = this.compileStatement(blockNode.statements[i], onVariable);
          return op.block("", children);
        }
      }

      case ts.SyntaxKind.ContinueStatement:
        return op.break("continue$" + this.currentBreakLabel);

      case ts.SyntaxKind.BreakStatement:
        return op.break("break$" + this.currentBreakLabel);

      case ts.SyntaxKind.ExpressionStatement:
      {
        const expressionNode = (<ts.ExpressionStatement>node).expression;
        const expr = this.compileExpression(expressionNode, voidType);
        return (<any>expressionNode).wasmType !== voidType ? op.drop(expr) : expr;
      }

      case ts.SyntaxKind.ReturnStatement:
      {
        const returnNode = <ts.ReturnStatement>node;

        if (this.currentFunction.returnType === voidType) {

          if (returnNode.expression)
            this.error(returnNode, "A void function cannot return a value", this.currentFunction.name);

          return op.return();

        } else {

          if (!returnNode.expression)
            this.error(returnNode, "A function with a return type must return a value", this.currentFunction.name);

          const returnExpr = <ts.Expression>returnNode.expression;

          return op.return(
            this.convertValue(
              returnExpr,
              this.compileExpression(returnExpr, this.currentFunction.returnType),
              <WasmType>(<any>returnExpr).wasmType,
              this.currentFunction.returnType,
              false
            )
          );
        }
      }

      default:
        this.error(node, "Unsupported statement node", ts.SyntaxKind[node.kind]);
    }
  }

  categoryOf(type: WasmType): WasmI32Operations | WasmI64Operations | WasmF32Operations | WasmF64Operations {
    return type.toBinaryenCategory(this.module, this.uintptrType);
  }

  zeroOf(type: WasmType): WasmI32Expression | WasmI64Expression | WasmF32Expression | WasmF64Expression {
    return type.toBinaryenZero(this.module, this.uintptrType);
  }

  oneOf(type: WasmType): WasmI32Expression | WasmI64Expression | WasmF32Expression | WasmF64Expression {
    return type.toBinaryenOne(this.module, this.uintptrType);
  }

  compileExpression(node: ts.Expression, contextualType: WasmType): WasmExpression {
    const op = this.module;
    // remember to always set 'wasmType' on 'node' here

    switch (node.kind) {

      case ts.SyntaxKind.ParenthesizedExpression:
      {
        const parenNode = (<ts.ParenthesizedExpression>node).expression;
        const parenExpr = this.compileExpression(parenNode, contextualType);
        const parenType = <WasmType>(<any>parenNode).wasmType;

        (<any>node).wasmType = parenType;

        return parenExpr;
      }

      case ts.SyntaxKind.AsExpression:
      {
        const asNode = <ts.AsExpression>node;
        const asType = this.resolveType(asNode.type);

        (<any>node).wasmType = asType;

        return this.convertValue(node, this.compileExpression(asNode.expression, contextualType), <WasmType>(<any>asNode.expression).wasmType, asType, true);
      }

      case ts.SyntaxKind.BinaryExpression:
      {
        const binaryNode = <ts.BinaryExpression>node;
        let leftExpr  = this.compileExpression(binaryNode.left, contextualType);
        let rightExpr = this.compileExpression(binaryNode.right, contextualType);
        const leftType  = <WasmType>(<any>binaryNode.left).wasmType;
        const rightType = <WasmType>(<any>binaryNode.right).wasmType;
        let resultType: WasmType;

        if (leftType.isAnyFloat) {

          if (rightType.isAnyFloat)
            resultType = leftType.size > rightType.size ? leftType : rightType;
          else
            resultType = leftType;

        } else if (rightType.isAnyFloat)
          resultType = rightType;
        else
          resultType = leftType.size > rightType.size ? leftType : rightType;

        // compile again with contextual result type so that literals are properly coerced
        if (leftType !== resultType)
          leftExpr = this.convertValue(binaryNode.left, this.compileExpression(binaryNode.left, resultType), leftType, resultType, false);
        if (rightType !== resultType)
          rightExpr = this.convertValue(binaryNode.right, this.compileExpression(binaryNode.right, resultType), rightType, resultType, false);

        const cat = this.categoryOf(resultType);

        (<any>binaryNode).wasmType = resultType;

        if (resultType.isAnyFloat) {

          const cat = <WasmF32Operations | WasmF64Operations>this.categoryOf(resultType);

          switch (binaryNode.operatorToken.kind) {

            case ts.SyntaxKind.PlusToken:
              return cat.add(leftExpr, rightExpr);

            case ts.SyntaxKind.MinusToken:
              return cat.sub(leftExpr, rightExpr);

            case ts.SyntaxKind.AsteriskToken:
              return cat.mul(leftExpr, rightExpr);

            case ts.SyntaxKind.SlashToken:
              return cat.div(leftExpr, rightExpr);

            case ts.SyntaxKind.EqualsEqualsToken:
              return cat.eq(leftExpr, rightExpr);

            case ts.SyntaxKind.ExclamationEqualsToken:
              return cat.ne(leftExpr, rightExpr);

            case ts.SyntaxKind.GreaterThanToken:
              return cat.gt(leftExpr, rightExpr);

            case ts.SyntaxKind.GreaterThanEqualsToken:
              return cat.ge(leftExpr, rightExpr);

            case ts.SyntaxKind.LessThanToken:
              return cat.lt(leftExpr, rightExpr);

            case ts.SyntaxKind.LessThanEqualsToken:
              return cat.le(leftExpr, rightExpr);

          }

        } else if (resultType.isAnyInteger) {

          const cat = <WasmI32Operations | WasmI64Operations>this.categoryOf(resultType);

          switch (binaryNode.operatorToken.kind) {

            case ts.SyntaxKind.PlusToken:
              return cat.add(leftExpr, rightExpr);

            case ts.SyntaxKind.MinusToken:
              return cat.sub(leftExpr, rightExpr);

            case ts.SyntaxKind.AsteriskToken:
              return cat.mul(leftExpr, rightExpr);

            case ts.SyntaxKind.SlashToken:
              if (resultType.isSigned)
                return cat.div_s(leftExpr, rightExpr);
              else
                return cat.div_u(leftExpr, rightExpr);

            case ts.SyntaxKind.PercentToken:
              if (resultType.isSigned)
                return cat.rem_s(leftExpr, rightExpr);
              else
                return cat.rem_u(leftExpr, rightExpr);

            case ts.SyntaxKind.AmpersandToken:
              return cat.and(leftExpr, rightExpr);

            case ts.SyntaxKind.BarToken:
              return cat.or(leftExpr, rightExpr);

            case ts.SyntaxKind.CaretToken:
              return cat.xor(leftExpr, rightExpr);

            case ts.SyntaxKind.LessThanLessThanToken:
              return cat.shl(leftExpr, rightExpr);

            case ts.SyntaxKind.GreaterThanGreaterThanToken:
              if (resultType.isSigned)
                return cat.shr_s(leftExpr, rightExpr);
              else
                return cat.shr_u(leftExpr, rightExpr);

            case ts.SyntaxKind.EqualsEqualsToken:
              return cat.eq(leftExpr, rightExpr);

            case ts.SyntaxKind.ExclamationEqualsToken:
              return cat.ne(leftExpr, rightExpr);

            case ts.SyntaxKind.GreaterThanToken:
              if (resultType.isSigned)
                return cat.gt_s(leftExpr, rightExpr);
              else
                return cat.gt_u(leftExpr, rightExpr);

            case ts.SyntaxKind.GreaterThanEqualsToken:
              if (resultType.isSigned)
                return cat.ge_s(leftExpr, rightExpr);
              else
                return cat.ge_u(leftExpr, rightExpr);

            case ts.SyntaxKind.LessThanToken:
              if (resultType.isSigned)
                return cat.lt_s(leftExpr, rightExpr);
              else
                return cat.lt_u(leftExpr, rightExpr);

            case ts.SyntaxKind.LessThanEqualsToken:
              if (resultType.isSigned)
                return cat.le_s(leftExpr, rightExpr);
              else
                return cat.le_u(leftExpr, rightExpr);

          }
        }

        this.error(binaryNode.operatorToken, "Unsupported binary operator", ts.SyntaxKind[binaryNode.operatorToken.kind]);
      }

      case ts.SyntaxKind.PrefixUnaryExpression:
      {
        const unaryNode = <ts.PrefixUnaryExpression>node;
        const unaryExpr = this.compileExpression(unaryNode.operand, contextualType);
        const operandType = <WasmType>(<any>unaryNode.operand).wasmType;

        switch (unaryNode.operator) {

          case ts.SyntaxKind.ExclamationToken:
          {
            (<any>node).wasmType = boolType;

            if (operandType === floatType)
              return op.f32.eq(unaryExpr, op.f32.const(0));

            else if (operandType === doubleType)
              return op.f64.eq(unaryExpr, op.f64.const(0));

            else if (operandType.isLong)
              return op.i64.eqz(unaryExpr);

            else
              return op.i32.eqz(unaryExpr);
          }

          case ts.SyntaxKind.PlusToken: // noop
          {
            (<any>node).wasmType = operandType;

            return unaryExpr;
          }

          case ts.SyntaxKind.MinusToken:
          {
            (<any>node).wasmType = operandType;

            if (operandType === floatType)
              return op.f32.neg(unaryNode.operand);

            else if (operandType === doubleType)
              return op.f64.neg(unaryNode.operand);

            else if (operandType.isLong)
              return op.i64.sub(op.i64.const(0, 0), unaryExpr);

            else
              return this.convertValue(node, op.i32.sub(op.i32.const(0), unaryExpr), intType, operandType, true);
          }

          case ts.SyntaxKind.TildeToken:
          {
            if (operandType.isLong) {

              (<any>node).wasmType = operandType;
              return op.i64.xor(unaryExpr, op.i64.const(-1, -1));

            } else if (operandType.isInt) {

              (<any>node).wasmType = operandType;
              return op.i32.xor(unaryExpr, op.i32.const(-1));

            } else if (contextualType.isLong) { // TODO: is the following correct / doesn't generate useless ops?

              (<any>node).wasmType = contextualType;
              return op.i64.xor(this.convertValue(unaryNode.operand, unaryExpr, operandType, contextualType, true), op.i64.const(-1, -1));

            } else {

              (<any>node).wasmType = intType;
              return op.i32.xor(this.convertValue(unaryNode.operand, unaryExpr, operandType, intType, true), op.i32.const(-1));

            }
          }

          case ts.SyntaxKind.PlusPlusToken:
          case ts.SyntaxKind.MinusMinusToken:
          {
            if (unaryNode.operand.kind === ts.SyntaxKind.Identifier) {

              const local = this.currentLocals[(<ts.Identifier>unaryNode.operand).text];
              if (local) {

                const cat = this.categoryOf(local.type);
                const one = this.oneOf(local.type);
                const isIncrement = unaryNode.operator === ts.SyntaxKind.PlusPlusToken;

                const calculate = (isIncrement ? cat.add : cat.sub).call(cat,
                  op.getLocal(
                    local.index,
                    local.type.toBinaryenType(this.uintptrType)
                  ),
                  one
                );

                (<any>node).wasmType = local.type;
                return this.convertValue(unaryNode, op.teeLocal(local.index, calculate), intType, local.type, true);
              }
            }
          }
        }

        this.error(unaryNode, "Unsupported unary prefix operation", ts.SyntaxKind[unaryNode.operator]);
        return unaryExpr;
      }

      case ts.SyntaxKind.PostfixUnaryExpression:
      {
        const unaryNode = <ts.PostfixUnaryExpression>node;
        const unaryExpr = this.compileExpression(unaryNode.operand, contextualType);

        (<any>unaryNode).wasmType = (<any>unaryNode.operand).wasmType;

        if (unaryNode.operand.kind === ts.SyntaxKind.Identifier)
        {
          const local = this.currentLocals[(<ts.Identifier>unaryNode.operand).text];

          if (local) {

            switch (unaryNode.operator) {

              case ts.SyntaxKind.PlusPlusToken:
              case ts.SyntaxKind.MinusMinusToken:
              {
                const cat = this.categoryOf(local.type);
                const one = this.oneOf(local.type);
                const isIncrement = unaryNode.operator === ts.SyntaxKind.PlusPlusToken;

                let calculate = (isIncrement ? cat.add : cat.sub).call(cat,
                  op.getLocal(
                    local.index,
                    local.type.toBinaryenType(this.uintptrType)
                  ),
                  one
                );

                if (local.type.isByte || local.type.isShort)
                  calculate = this.convertValue(unaryNode, calculate, intType, local.type, true);

                return (isIncrement ? cat.sub : cat.add).call(cat, op.teeLocal(local.index, calculate), one);
              }
            }
          }
        }

        this.error(unaryNode, "Unsupported unary postfix operation");
        return unaryExpr;
      }

      case ts.SyntaxKind.FirstLiteralToken:
      {
        let literalText = (<ts.LiteralExpression>node).text;
        let integerRadix: number;

        switch (literalText) {

          case "true":
            literalText = "1";
            break;

          case "false":
          case "null":
            literalText = "0";
            break;
        }

        if (/^(?:0|[1-9][0-9]*)$/.test(literalText)) {

          integerRadix = 10;

        } else if (/^0[xX][0-9A-Fa-f]+$/.test(literalText)) {

          integerRadix = 16;
          literalText = literalText.substring(2);

        } else if (/^(?![eE])[0-9]*(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?$/.test(literalText)) {

          if (!contextualType.isAnyFloat) { // explicit float in non-float context must be converted
            (<any>node).wasmType = doubleType;
            return op.f64.const(parseFloat(literalText));
          }

        } else {

          this.error(node, "Unsupported literal", literalText);
          literalText = "0";
          integerRadix = 10;
        }

        (<any>node).wasmType = contextualType;

        switch (contextualType) {

          case floatType:
            return op.f32.const(parseFloat(literalText));

          case doubleType:
            return op.f64.const(parseFloat(literalText));

          case sbyteType:
          case shortType:
            return op.i32.const(((parseInt(literalText, integerRadix) >>> 0) << contextualType.shift32) >> contextualType.shift32);

          case byteType:
          case ushortType:
          case intType:
          case uintType:
          case uintptrType32:
            return op.i32.const(parseInt(literalText, integerRadix) & ((contextualType.size << 8) - 1));

          case longType:
          case ulongType:
          case uintptrType64:
            const long = Long.fromString(literalText, contextualType === ulongType, integerRadix);
            return op.i64.const(long.low, long.high);

          case boolType:
            return op.i32.const(parseInt(literalText, integerRadix) !== 0 ? 1 : 0);
        }
      }

      case ts.SyntaxKind.Identifier:
      {
        const identNode = <ts.Identifier>node;
        const referencedLocal = this.currentLocals[identNode.text];

        if (referencedLocal == null) {
          this.error(node, "Undefined local variable", identNode.text);
          return op.unreachable();
        }

        (<any>node).wasmType = referencedLocal.type;

        return op.getLocal(referencedLocal.index, referencedLocal.type.toBinaryenType(this.uintptrType));
      }

      case ts.SyntaxKind.PropertyAccessExpression:
      {
        const accessNode = <ts.PropertyAccessExpression>node;

        if (accessNode.expression.kind === ts.SyntaxKind.Identifier) {
          const targetName = (<ts.Identifier>accessNode.expression).text;

          if (accessNode.name.kind === ts.SyntaxKind.Identifier) {
            const propertyName = (<ts.Identifier>accessNode.name).text;
            const referencedConstant = this.constants[targetName + "$" + propertyName];

            if (referencedConstant) {
              switch (referencedConstant.type) {

                case byteType:
                case sbyteType:
                case shortType:
                case ushortType:
                case intType:
                case uintType:
                case uintptrType32:

                  (<any>node).wasmType = intType;
                  return op.i32.const(referencedConstant.value);

                case longType:
                case ulongType:
                case uintptrType64:

                  const long = Long.fromValue(referencedConstant.value);
                  (<any>node).wasmType = longType;
                  return op.i64.const(long.low, long.high);

                case floatType:

                  (<any>node).wasmType = floatType;
                  return op.f32.const(referencedConstant.value);

                case doubleType:

                  (<any>node).wasmType = doubleType;
                  return op.f64.const(referencedConstant.value);

              }
            }
          }
        }

        this.error(node, "Unsupported property access");
      }

      case ts.SyntaxKind.TrueKeyword:

        if (contextualType.isLong) {

          (<any>node).wasmType = longType;
          return op.i64.const(1, 0);

        } else { // TODO: this should result in an invalid implicit conversion for floats, does it?

          (<any>node).wasmType = intType;
          return op.i32.const(1);

        }

      case ts.SyntaxKind.FalseKeyword:
      case ts.SyntaxKind.NullKeyword:

        if (contextualType.isLong) {

          (<any>node).wasmType = longType;
          return op.i64.const(0, 0);

        } else { // TODO: see comment above

          (<any>node).wasmType = intType;
          return op.i32.const(0);

        }

      case ts.SyntaxKind.CallExpression:
      {
        const callNode = <ts.CallExpression>node;
        const declaration = this.checker.getResolvedSignature(callNode).declaration;
        const wasmFunction = <WasmFunction>(<any>declaration).wasmFunction;
        const argumentExpressions: WasmExpression[] = new Array(wasmFunction.parameterTypes.length);

        (<any>node).wasmType = wasmFunction.returnType;

        let i = 0;

        if ((wasmFunction.flags & WasmFunctionFlags.instance) !== 0)
          argumentExpressions[i++] = op.getLocal(0, wasmFunction.parameterTypes[0].toBinaryenType(this.uintptrType));

        for (let k = argumentExpressions.length; i < k; ++i)
          argumentExpressions[i] = this.compileExpression(callNode.arguments[i], wasmFunction.parameterTypes[i]);

        if (i < argumentExpressions.length) { // TODO: pull default value initializers from declaration

          this.error(callNode, "Invalid number of arguemnts", "Expected " + declaration.parameters.length + " but saw " + callNode.arguments.length);
          return op.unreachable();

        }

        if (!isImport(declaration)) { // user function

          return op.call(wasmFunction.name, argumentExpressions, wasmFunction.returnType.toBinaryenType(this.uintptrType));

        } else { // import or builtin

          if (wasmFunction)

            return op.call(wasmFunction.name, argumentExpressions, wasmFunction.returnType.toBinaryenType(this.uintptrType));

          switch (declaration.symbol.name) {

            case "rotl":
            case "rotll":
              return builtins.rotl(this, [ callNode.arguments[0], callNode.arguments[1] ], [ argumentExpressions[0], argumentExpressions[1] ]);

            case "rotr":
            case "rotrl":
              return builtins.rotr(this, [ callNode.arguments[0], callNode.arguments[1] ], [ argumentExpressions[0], argumentExpressions[1] ]);

            case "clz":
            case "clzl":
              return builtins.clz(this, callNode.arguments[0], argumentExpressions[0]);

            case "ctz":
            case "ctzl":
              return builtins.ctz(this, callNode.arguments[0], argumentExpressions[0]);

            case "popcnt":
            case "popcntl":
              return builtins.popcnt(this, callNode.arguments[0], argumentExpressions[0]);

            case "abs":
            case "absf":
              return builtins.abs(this, callNode.arguments[0], argumentExpressions[0]);

            case "ceil":
            case "ceilf":
              return builtins.ceil(this, callNode.arguments[0], argumentExpressions[0]);

            case "floor":
            case "floorf":
              return builtins.floor(this, callNode.arguments[0], argumentExpressions[0]);

            case "sqrt":
            case "sqrtf":
              return builtins.sqrt(this, callNode.arguments[0], argumentExpressions[0]);

            case "trunc":
            case "truncf":
              return builtins.trunc(this, callNode.arguments[0], argumentExpressions[0]);

            case "nearest":
            case "nearestf":
              return builtins.nearest(this, callNode.arguments[0], argumentExpressions[0]);

            case "min":
            case "minf":
              return builtins.min(this, [ callNode.arguments[0], callNode.arguments[1] ], [ argumentExpressions[0], argumentExpressions[1] ]);

            case "max":
            case "maxf":
              return builtins.max(this, [ callNode.arguments[0], callNode.arguments[1] ], [ argumentExpressions[0], argumentExpressions[1] ]);

          }
        }

        this.error(callNode, "Unimplemented function");
        return op.unreachable();
      }

      default:
        this.error(node, "Unsupported expression node", ts.SyntaxKind[node.kind]);
    }
  }

  convertValue(node: ts.Node, expr: WasmExpression, fromType: WasmType, toType: WasmType, explicit: boolean): WasmExpression {
    if (fromType.kind === toType.kind)
      return expr;

    const _this = this;
    const op = this.module;

    function illegalImplicitConversion() {
      _this.error(node, "Cannot convert from '" + fromType + "' to '" + toType + "' without a cast");
      explicit = true; // report this only once for the topmost node
    }

    (<any>node).wasmType = toType;

    if (fromType === floatType) {

      if (!explicit && toType !== doubleType)
        illegalImplicitConversion();

      switch (toType) {

        case byteType:
        case ushortType:
        case boolType:
          return this.convertValue(node, op.i32.trunc_u.f32(expr), intType, toType, explicit);

        case uintType:
        case uintptrType32:
          return op.i32.trunc_u.f32(expr);

        case sbyteType:
        case shortType:
          return this.convertValue(node, op.i32.trunc_s.f32(expr), intType, toType, explicit);

        case intType:
          return op.i32.trunc_s.f32(expr);

        case ulongType:
        case uintptrType64:
          return op.i64.trunc_u.f32(expr);

        case longType:
          return op.i64.trunc_s.f32(expr);

        // floatType == floatType

        case doubleType:
          return op.f64.promote(expr);

      }

    } else if (fromType === doubleType) {

      if (!explicit) illegalImplicitConversion();

      switch (toType) {

        case byteType:
        case ushortType:
        case boolType:
          return this.convertValue(node, op.i32.trunc_u.f64(expr), intType, toType, explicit);

        case uintType:
        case uintptrType32:
          return op.i32.trunc_u.f64(expr);

        case sbyteType:
        case shortType:
          return this.convertValue(node, op.i32.trunc_s.f64(expr), intType, toType, explicit);

        case intType:
          return op.i32.trunc_s.f64(expr);

        case ulongType:
        case uintptrType64:
          return op.i64.trunc_u.f64(expr);

        case longType:
          return op.i64.trunc_s.f64(expr);

        case floatType:
          return op.f32.demote(expr);

        // doubleType == doubleType

      }

    } else if (toType === floatType) { // int to float

      switch (fromType) {

        case uintType:
        case uintptrType32:
          if (!explicit) illegalImplicitConversion();

        case byteType:
        case ushortType:
        case boolType:
          return op.f32.convert_u.i32(expr);

        case intType:
          if (!explicit) illegalImplicitConversion();

        case sbyteType:
        case shortType:
          return op.f32.convert_s.i32(expr);

        case ulongType:
        case uintptrType64:
          if (!explicit) illegalImplicitConversion();
          return op.f32.convert_u.i64(expr);

        case longType:
          if (!explicit) illegalImplicitConversion();
          return op.f32.convert_s.i64(expr);

      }

    } else if (toType === doubleType) { // int to double

      switch (fromType) {

        case uintType:
        case uintptrType32:
        case byteType:
        case ushortType:
        case boolType:
          return op.f64.convert_u.i32(expr);

        case intType:
        case sbyteType:
        case shortType:
          return op.f64.convert_s.i32(expr);

        case ulongType:
        case uintptrType64:
          if (!explicit) illegalImplicitConversion();
          return op.f64.convert_u.i64(expr);

        case longType:
          if (!explicit) illegalImplicitConversion();
          return op.f64.convert_s.i64(expr);

      }

    } else if (fromType.isInt && toType.isLong) {

      if (toType.isSigned)
        return op.i64.extend_s(expr);
      else
        return op.i64.extend_u(expr);

    } else if (fromType.isLong && toType.isInt) {

      if (!explicit) illegalImplicitConversion();

      expr = op.i32.wrap(expr);
      fromType = fromType.isSigned ? intType : uintType;

      // fallthrough
    }

    // int to other int

    if (fromType.size < toType.size || toType.isInt)
      return expr;

    if (!explicit) illegalImplicitConversion();

    if (toType.isSigned) {

      return op.i32.shl(
        op.i32.shr_s(
          expr,
          op.i32.const(toType.shift32)
        ),
        op.i32.const(toType.shift32)
      );

    } else {

      return op.i32.and(
        expr,
        op.i32.const(toType.mask32)
      );

    }
  }

  resolveType(type: ts.TypeNode, acceptVoid: boolean = false): WasmType {
    const text = type.getText();

    switch (text) {
      case "byte":return byteType;
      case "sbyte": return sbyteType;
      case "short": return shortType;
      case "ushort": return ushortType;
      case "int": return intType;
      case "uint": return uintType;
      case "long": return longType;
      case "ulong": return ulongType;
      case "bool": return boolType;
      case "float": return floatType;
      case "double": return doubleType;
      case "uintptr": return this.uintptrType;
      case "void": if (acceptVoid) return voidType;
    }

    if (type.kind == ts.SyntaxKind.TypeReference) {
      var reference = <ts.TypeReferenceNode>type;

      switch (reference.typeName.getText()) {

        case "Ptr":
          if (reference.typeArguments.length !== 1)
            throw Error("illegal number of type parameters on Ptr<T>");
          if (reference.typeArguments[0].kind !== ts.SyntaxKind.TypeReference)
            throw Error("unsupported type parameter on Ptr<T>");
          return this.uintptrType.withUnderlyingType(this.resolveType(<ts.TypeReferenceNode>reference.typeArguments[0]));

      }
    }

    throw Error("unsupported type: " + text);
  }
}
