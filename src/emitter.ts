import * as ts from 'typescript';
import * as sourceMap from 'source-map';
import { BinaryWriter } from './binarywriter';
import { FunctionContext, UpvalueInfo } from './contexts';
import { IdentifierResolver, ResolvedInfo, ResolvedKind } from './resolvers';
import { Ops, OpMode, OpCodes, LuaTypes } from './opcodes';
import { Helpers } from './helpers';
import * as path from 'path';
import { Preprocessor } from './preprocessor';
import { TypeInfo } from './typeInfo';

export class Emitter {
    public writer: BinaryWriter = new BinaryWriter();
    public fileModuleName: string;
    private functionContextStack: Array<FunctionContext> = [];
    private functionContext: FunctionContext;
    private resolver: IdentifierResolver;
    private preprocessor: Preprocessor;
    private typeInfo: TypeInfo;
    private sourceFileName: string;
    private opsMap = [];
    private extraDebugEmbed = false;
    private generateSourceMap = false;
    private allowConstBigger255 = false;
    // can be used for testing to load const separately
    private splitConstFromOpCode = false;
    private sourceMapGenerator: sourceMap.SourceMapGenerator;
    private filePathLua: string;
    private filePathLuaMap: string;
    private ignoreDebugInfo: boolean;
    private jsLib: boolean;

    public constructor(
        typeChecker: ts.TypeChecker, private options: ts.CompilerOptions,
        private cmdLineOptions: any, private singleModule: boolean, private rootFolder?: string) {
        this.resolver = new IdentifierResolver(typeChecker);
        this.typeInfo = new TypeInfo(this.resolver);
        this.preprocessor = new Preprocessor(this.resolver, this.typeInfo);
        this.functionContext = new FunctionContext();

        this.opsMap[ts.SyntaxKind.PlusToken] = Ops.ADD;
        this.opsMap[ts.SyntaxKind.MinusToken] = Ops.SUB;
        this.opsMap[ts.SyntaxKind.AsteriskToken] = Ops.MUL;
        this.opsMap[ts.SyntaxKind.PercentToken] = Ops.MOD;
        this.opsMap[ts.SyntaxKind.AsteriskAsteriskToken] = Ops.POW;
        this.opsMap[ts.SyntaxKind.SlashToken] = Ops.DIV;
        this.opsMap[ts.SyntaxKind.AmpersandToken] = Ops.BAND;
        this.opsMap[ts.SyntaxKind.BarToken] = Ops.BOR;
        this.opsMap[ts.SyntaxKind.CaretToken] = Ops.BXOR;
        this.opsMap[ts.SyntaxKind.LessThanLessThanToken] = Ops.SHL;
        this.opsMap[ts.SyntaxKind.GreaterThanGreaterThanToken] = Ops.SHR;
        this.opsMap[ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken] = Ops.SHR;
        this.opsMap[ts.SyntaxKind.EqualsEqualsToken] = Ops.EQ;
        this.opsMap[ts.SyntaxKind.EqualsEqualsEqualsToken] = Ops.EQ;
        this.opsMap[ts.SyntaxKind.LessThanToken] = Ops.LT;
        this.opsMap[ts.SyntaxKind.LessThanEqualsToken] = Ops.LE;
        this.opsMap[ts.SyntaxKind.ExclamationEqualsToken] = Ops.EQ;
        this.opsMap[ts.SyntaxKind.ExclamationEqualsEqualsToken] = Ops.EQ;
        this.opsMap[ts.SyntaxKind.GreaterThanToken] = Ops.LE;
        this.opsMap[ts.SyntaxKind.GreaterThanEqualsToken] = Ops.LT;

        this.opsMap[ts.SyntaxKind.PlusEqualsToken] = Ops.ADD;
        this.opsMap[ts.SyntaxKind.MinusEqualsToken] = Ops.SUB;
        this.opsMap[ts.SyntaxKind.AsteriskEqualsToken] = Ops.MUL;
        this.opsMap[ts.SyntaxKind.PercentEqualsToken] = Ops.MOD;
        this.opsMap[ts.SyntaxKind.AsteriskAsteriskEqualsToken] = Ops.POW;
        this.opsMap[ts.SyntaxKind.SlashEqualsToken] = Ops.DIV;
        this.opsMap[ts.SyntaxKind.AmpersandEqualsToken] = Ops.BAND;
        this.opsMap[ts.SyntaxKind.BarEqualsToken] = Ops.BOR;
        this.opsMap[ts.SyntaxKind.CaretEqualsToken] = Ops.BXOR;
        this.opsMap[ts.SyntaxKind.LessThanLessThanEqualsToken] = Ops.SHL;
        this.opsMap[ts.SyntaxKind.GreaterThanGreaterThanEqualsToken] = Ops.SHR;
        this.opsMap[ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken] = Ops.SHR;

        this.extraDebugEmbed = cmdLineOptions.extradebug ? true : false;
        if (options && options.outFile && singleModule) {
            this.fileModuleName = options.outFile;
        }

        this.generateSourceMap = ((options && options.sourceMap) || false);

        this.jsLib = (
            options
            && options.lib
            && options.lib.some(l => /lib.es\d+.d.ts/.test(l))
            && !options.lib.some(l => /lib.es5.d.ts/.test(l))
            || cmdLineOptions.jslib)
                ? true
                : false;
    }

    private libCommon = '                                           \
    __type = __type || type;                                        \
                                                                    \
    __instanceof = __instanceof || function(inst:object, type:object) { \
        if (!inst) {                                                \
            return false;                                           \
        }                                                           \
                                                                    \
        let mt:object;                                              \
        switch (__type(inst)) {                                     \
            case "table":                                           \
                mt = inst.__proto;                                  \
                break;                                              \
            case "number":                                          \
                mt = Number;                                        \
                break;                                              \
            case "string":                                          \
                mt = String;                                        \
                break;                                              \
            case "boolean":                                         \
                mt = Boolean;                                       \
                break;                                              \
        }                                                           \
                                                                    \
        while (mt) {                                                \
            if (mt == type) {                                       \
                return true;                                        \
            }                                                       \
                                                                    \
            mt = mt.__proto;                                        \
        }                                                           \
                                                                    \
        return false;                                               \
    }                                                               \
                                                                    \
    __get_static_call__ = __get_static_call__ || function (t, k) {  \
        const getmethod:object = rawget(t, "__get__")[k];           \
        if (getmethod) {                                            \
            return getmethod(t);                                    \
        }                                                           \
                                                                    \
        return rawget(t, k) || rawget(t, "__proto") && t.__proto[k];\
    }                                                               \
                                                                    \
    __set_static_call__ = __set_static_call__ || function (t, k, v) {\
        const setmethod:object = rawget(t, "__set__")[k];           \
        if (setmethod) {                                            \
            setmethod(t, v);                                        \
            return;                                                 \
        }                                                           \
                                                                    \
        rawset(t, k, v);                                            \
    }                                                               \
                                                                    \
    __get_call__ = __get_call__ || function (t, k) {                \
        let proto:object = t.__proto;                               \
        while (proto) {                                             \
            let get_:object = proto.__get__;                        \
            const getmethod:object = get_ && get_[k];               \
            if (getmethod) {                                        \
                return getmethod(t);                                \
            }                                                       \
                                                                    \
            proto = proto.__proto;                                  \
        }                                                           \
                                                                    \
        return rawget(t, k) || t.__proto[k];                        \
    }                                                               \
                                                                    \
    __set_call__ = __set_call__ || function (t, k, v) {             \
        let proto:object = t.__proto;                               \
        while (proto) {                                             \
            let set_:object = proto.__set__;                        \
            const setmethod:object = set_ && set_[k];               \
            if (setmethod) {                                        \
                setmethod(t, v);                                    \
                return;                                             \
            }                                                       \
                                                                    \
            proto = proto.__proto;                                  \
        }                                                           \
                                                                    \
        rawset(t, k, v);                                            \
    }                                                               \
                                                                    \
    __wrapper = __wrapper || function(method: object, _this: object) { \
        if (!method) {                                              \
            return method;                                          \
        }                                                           \
                                                                    \
        return function (...params: any[]) {                        \
            return method(_this, ...params);                        \
        };                                                          \
    }                                                               \
                                                                    \
    __bind = __bind || function(method: object, _this: object, ...prependParams: any[]) { \
        if (!method) {                                              \
            return method;                                          \
        }                                                           \
                                                                    \
        if (prependParams[0]) {                                     \
            return function (...params: any[]) {                    \
                return method(_this, ...prependParams, ...params);  \
            };                                                      \
        }                                                           \
                                                                    \
        return function (...params: any[]) {                        \
            return prependParams && method(_this, ...params);       \
        };                                                          \
    }                                                               \
    ';

    /*
    -- new instance
    local a = {}
    --a.__index = proto
    a.__index = __get_call__
    a.__proto = proto
    a.__newindex = __set_call__

    setmetatable(a, a)
    */

    public printNode(node: ts.Statement): string {
        const sourceFile = ts.createSourceFile(
            'noname', '', ts.ScriptTarget.ES2018, /*setParentNodes */ true, ts.ScriptKind.TS);

        (<any>sourceFile.statements) = [node];

        // debug output
        const emitter = ts.createPrinter({
            newLine: ts.NewLineKind.LineFeed,
        });

        const result = emitter.printNode(ts.EmitHint.SourceFile, sourceFile, sourceFile);
        return result;
    }

    public processNode(node: ts.Node): void {
        switch (node.kind) {
            case ts.SyntaxKind.SourceFile: this.processFile(<ts.SourceFile>node);
                break;
            case ts.SyntaxKind.Bundle: this.processBundle(<ts.Bundle>node);
                break;
            case ts.SyntaxKind.UnparsedSource: this.processUnparsedSource(<ts.UnparsedSource>node);
                break;
            default:
                // TODO: finish it
                throw new Error('Method not implemented.');
        }
    }

    public save() {
        // add final return
        if (!this.functionContext.isFinalReturnAdded) {
            this.functionContext.code.push([Ops.RETURN, 0, 1]);
            this.functionContext.isFinalReturnAdded = true;
        }

        this.emitHeader();
        // f->sizeupvalues (byte)
        this.writer.writeByte(this.functionContext.upvalues.length);
        this.emitFunction(this.functionContext);

        if (this.sourceMapGenerator) {
            ts.sys.writeFile(this.filePathLuaMap, this.sourceMapGenerator.toString());
        }
    }

    private pushFunctionContext(location: ts.Node) {
        const localFunctionContext = this.functionContext;
        this.functionContextStack.push(localFunctionContext);
        this.functionContext = new FunctionContext();
        this.functionContext.function_or_file_location_node = location;
        if (localFunctionContext) {
            this.functionContext.container = localFunctionContext;
            this.functionContext.current_location_node = localFunctionContext.current_location_node;
            this.functionContext.location_scopes = localFunctionContext.location_scopes;
        }
    }

    private popFunctionContext(): FunctionContext {
        const localFunctionContext = this.functionContext;
        this.functionContext = this.functionContextStack.pop();
        return localFunctionContext;
    }

    private processFunction(
        location: ts.Node,
        statements: ts.NodeArray<ts.Statement>,
        parameters: ts.NodeArray<ts.ParameterDeclaration>,
        createEnvironment?: boolean): FunctionContext {

        this.pushFunctionContext(location);
        this.processFunctionWithinContext(location, statements, parameters, createEnvironment);
        return this.popFunctionContext();
    }

    private hasMemberThis(location: ts.Node): boolean {
        if (!location) {
            return false;
        }

        if (location.parent && location.parent.kind !== ts.SyntaxKind.ClassDeclaration) {
            return false;
        }

        switch (location.kind) {
            case ts.SyntaxKind.Constructor:
                return true;
            case ts.SyntaxKind.MethodDeclaration:
            case ts.SyntaxKind.SetAccessor:
            case ts.SyntaxKind.GetAccessor:
                const isStatic = location.modifiers && location.modifiers.some(m => m.kind === ts.SyntaxKind.StaticKeyword);
                return !isStatic;
            case ts.SyntaxKind.PropertyDeclaration:
                return false;
        }

        return false;
    }

    private discoverModuleNode(location: ts.Node): string {
        let moduleName: string = null;
        function checkMoudleNode(node: ts.Node): any {
            if (node.kind === ts.SyntaxKind.ModuleDeclaration) {
                moduleName = (<ts.ModuleDeclaration>node).name.text;
                return true;
            }

            ts.forEachChild(node, checkMoudleNode);
        }

        ts.forEachChild(location, checkMoudleNode);
        return moduleName;
    }

    private hasNodeUsedThis(location: ts.Node): boolean {
        let createThis = false;
        function checkThisKeyward(node: ts.Node): any {
            if (node.kind === ts.SyntaxKind.ThisKeyword) {
                createThis = true;
                return true;
            }

            ts.forEachChild(node, checkThisKeyward);
        }

        ts.forEachChild(location, checkThisKeyward);
        return createThis;
    }

    private processDebugInfo(nodeIn: ts.Node, functionContext: FunctionContext) {
        let node = nodeIn;
        let file = node.getSourceFile();
        if (!file) {
            node = (<any>node).__origin;
            file = node.getSourceFile();
            if (!file) {
                return;
            }
        }

        if (node.pos === -1) {
            return;
        }

        const locStart = (<any>ts).getLineAndCharacterOfPosition(file, node.getStart(node.getSourceFile()));
        const locEnd = (<any>ts).getLineAndCharacterOfPosition(file, node.getEnd());

        if (this.sourceMapGenerator) {
            const fileSubPath = Helpers.getSubPath(this.filePathLua, (<any>this.sourceMapGenerator)._sourceRoot);
            functionContext.debug_location = '@' + fileSubPath;
        } else {
            if (!functionContext.debug_location) {
                functionContext.debug_location = '@' + file.fileName;
            } else {
                functionContext.debug_location = '@' + this.fileModuleName + '.lua';
            }

            switch (node.kind) {
                case ts.SyntaxKind.FunctionDeclaration:
                    functionContext.debug_location +=
                        ':' + ((<ts.FunctionDeclaration>node).name ? (<ts.FunctionDeclaration>node).name.text : 'noname');
                    break;
                case ts.SyntaxKind.FunctionExpression:
                    functionContext.debug_location +=
                        ':' + ((<ts.FunctionExpression>node).name ? (<ts.FunctionExpression>node).name.text : 'noname');
                    break;
                case ts.SyntaxKind.ArrowFunction:
                    functionContext.debug_location +=
                        ':' + ((<ts.FunctionExpression>node).name ? (<ts.FunctionExpression>node).name.text : 'arrow');
                    break;
                case ts.SyntaxKind.TryStatement:
                    functionContext.debug_location += ':try';
                    break;
                case ts.SyntaxKind.Constructor:
                    functionContext.debug_location += ':' + (<ts.ClassDeclaration>node.parent).name.text + ':ctor';
                    break;
                case ts.SyntaxKind.MethodDeclaration:
                    functionContext.debug_location +=
                        ':' + (<ts.ClassDeclaration>node.parent).name.text +
                        ':' + (<ts.Identifier>(<ts.MethodDeclaration>node).name).text;
                    break;
                case ts.SyntaxKind.GetAccessor:
                    functionContext.debug_location +=
                        ':' + (<ts.ClassDeclaration>node.parent).name.text +
                        ':' + (<ts.Identifier>(<ts.GetAccessorDeclaration>node).name).text + ':get';
                    break;
                case ts.SyntaxKind.SetAccessor:
                    functionContext.debug_location +=
                        ':' + (<ts.ClassDeclaration>node.parent).name.text +
                        ':' + (<ts.Identifier>(<ts.SetAccessorDeclaration>node).name).text + ':set';
                    break;
                case ts.SyntaxKind.SourceFile:
                    break;
                default:
                    throw new Error('Not Implemented');
            }

            if (node.kind !== ts.SyntaxKind.SourceFile) {
                functionContext.linedefined = locStart.line + 1;
                functionContext.lastlinedefined = locEnd.line + 1;
            } else {
                functionContext.linedefined = 0;
                functionContext.lastlinedefined = 0;
            }
        }
    }

    private getBodyByDecorators(statementsIn: ts.NodeArray<ts.Statement>, location: ts.Node): ts.NodeArray<ts.Statement> {
        const len = location.decorators
            && location.decorators.some(
                m => m.expression.kind === ts.SyntaxKind.Identifier && (<ts.Identifier>m.expression).text === 'len');

        if (len) {
            const firstParam = (<ts.MethodDeclaration>location).parameters[0];
            const operand = firstParam ? <ts.Identifier>firstParam.name : ts.createThis();
            const lengthMemeber = ts.createIdentifier('length');
            (<any>lengthMemeber).__len = true;
            /*
            return <ts.NodeArray<ts.Statement>><any>
                [<ts.Statement>ts.createReturn(
                    ts.createBinary(
                        ts.createPropertyAccess(operand, lengthMemeber),
                        ts.SyntaxKind.PlusToken,
                        ts.createConditional(
                            ts.createElementAccess(operand, ts.createNumericLiteral('0')),
                            ts.createNumericLiteral('1'),
                            ts.createNumericLiteral('0'))))
                ];
            */
            return <ts.NodeArray<ts.Statement>><any>
                [
                    <ts.Statement>ts.createReturn(ts.createPropertyAccess(operand, lengthMemeber))
                ];
        }

        return statementsIn;
    }

    private processFunctionWithinContext(
        location: ts.Node,
        statementsIn: ts.NodeArray<ts.Statement>,
        parameters: ts.NodeArray<ts.ParameterDeclaration>,
        createEnvironment?: boolean,
        noReturn?: boolean) {

        const effectiveLocation = (<any>location).__origin ? (<any>location).__origin : location;
        const statements = this.getBodyByDecorators(statementsIn, effectiveLocation);

        this.functionContext.newLocalScope(effectiveLocation);

        this.functionContext.isStatic =
            effectiveLocation.modifiers && effectiveLocation.modifiers.some(m => m.kind === ts.SyntaxKind.StaticKeyword);

        const isClassDeclaration = this.functionContext.container
            && this.functionContext.container.current_location_node
            && this.functionContext.container.current_location_node.kind === ts.SyntaxKind.ClassDeclaration;

        this.functionContext.thisInUpvalue =
            location.kind === ts.SyntaxKind.ArrowFunction
            && !isClassDeclaration || location.kind === ts.SyntaxKind.TryStatement;

        const isMethod = location.kind === ts.SyntaxKind.FunctionDeclaration
            || location.kind === ts.SyntaxKind.FunctionExpression
            || location.kind === ts.SyntaxKind.ArrowFunction
            || location.kind === ts.SyntaxKind.MethodDeclaration
            || location.kind === ts.SyntaxKind.Constructor
            || location.kind === ts.SyntaxKind.SetAccessor
            || location.kind === ts.SyntaxKind.GetAccessor;

        const isAccessor = effectiveLocation.kind === ts.SyntaxKind.SetAccessor
            || effectiveLocation.kind === ts.SyntaxKind.GetAccessor;

        // debug info
        this.processDebugInfo(location, this.functionContext);

        if (createEnvironment) {
            this.resolver.createEnv(this.functionContext);

            // we need to inject helper functions
            this.processTSCode(this.libCommon, true);
        }

        let addThisAsParameter = false;
        const origin = (<ts.Node>(<any>location).__origin);
        if (isMethod && (origin || !this.functionContext.thisInUpvalue)) {
            const createThis = (this.hasMemberThis(origin) || this.hasNodeUsedThis(location))
                && !(isClassDeclaration && this.functionContext.isStatic && !isAccessor);
            if (createThis) {
                const thisIsInParams = parameters && parameters.some(p => (<ts.Identifier>p.name).text === 'this');
                if (!thisIsInParams) {
                    this.functionContext.createParam('this');
                    addThisAsParameter = true;
                }
            }
        }

        if (parameters) {
            let dotDotDotAny = false;
            parameters.forEach(p => {
                this.functionContext.createParam((<ts.Identifier>p.name).text);
                if (p.dotDotDotToken) {
                    dotDotDotAny = true;
                }
            });

            this.functionContext.numparams = parameters.length + (addThisAsParameter ? 1 : 0) - (dotDotDotAny ? 1 : 0);
            this.functionContext.is_vararg = dotDotDotAny;
        }

        // select all parameters with default values
        if (parameters) {
            parameters
                .filter(p => p.initializer)
                .map(p => ts.createIf(
                    ts.createPrefix(ts.SyntaxKind.ExclamationToken, <ts.Identifier>p.name),
                    ts.createStatement(ts.createAssignment(<ts.Identifier>p.name, p.initializer))))
                .forEach(s => {
                    this.processStatement(s);
                });

            // we need to load all '...<>' into arrays
            parameters.filter(p => p.dotDotDotToken).forEach(p => {
                const localVar = this.functionContext.findLocal((<ts.Identifier>p.name).text);
                // TODO: disabled as ...<TABLE> does not work for Array<T>. (finish implementation)
                if (false && this.jsLib) {
                    const initializeNewArg = (arrayRef: ResolvedInfo) => {
                        this.functionContext.code.push([Ops.VARARG, arrayRef.getRegister() + 1, 0, 0]);
                        this.functionContext.code.push([Ops.SETLIST, arrayRef.getRegister(), 0, 1]);
                    };

                    const newArray = ts.createNew(ts.createIdentifier('Array'), undefined, []);
                    this.processNewExpression(newArray, initializeNewArg);
                    const resultInfo = this.functionContext.stack.pop();

                    this.functionContext.code.push([
                        Ops.MOVE,
                        localVar,
                        resultInfo.getRegister()
                    ]);
                } else {
                    this.functionContext.code.push([Ops.NEWTABLE, localVar, 0, 0]);
                    this.functionContext.code.push([Ops.VARARG, localVar + 1, 0, 0]);
                    this.functionContext.code.push([Ops.SETLIST, localVar, 0, 1]);

                    // set length for table
                    const reservedResult = this.functionContext.useRegisterAndPush();
                    this.AddLengthToConstArray(localVar);
                    this.functionContext.stack.pop();
                }
            });
        }

        statements.forEach(s => {
            this.processStatement(s);
        });

        if (!noReturn) {
            // add final 'RETURN'
            this.functionContext.code.push([Ops.RETURN, 0, 1]);
        }

        this.functionContext.restoreLocalScope();

        if (this.functionContext.availableRegister !== 0) {
            throw new Error('stack is not cleaned up');
        }
    }

    private AddLengthToConstArray(localVar: number) {
        const lenResult = this.functionContext.useRegisterAndPush();

        this.functionContext.code.push([Ops.LEN,
            lenResult.getRegister(),
            localVar]);

        const lenNameInfo = this.resolver.returnConst('length', this.functionContext);
        this.functionContext.code.push([Ops.SETTABLE,
            localVar,
            lenNameInfo.getRegisterOrIndex(),
            lenResult.getRegisterOrIndex()]);

        this.functionContext.stack.pop();
    }

    private processFile(sourceFile: ts.SourceFile): void {
        if (this.generateSourceMap) {
            const filePath: string = Helpers.correctFileNameForLua((<any>sourceFile).__path);
            this.filePathLua = filePath.replace(/\.ts$/, '.lua');
            this.filePathLuaMap = filePath.replace(/\.ts$/, '.lua.map');

            // check if we have module declaration
            if (this.singleModule) {
                if (!this.fileModuleName) {
                    this.fileModuleName = this.discoverModuleNode(sourceFile);
                }

                if (this.fileModuleName) {
                    this.filePathLua = path.join(path.dirname(filePath), this.fileModuleName + '.lua');
                    this.filePathLuaMap = path.join(path.dirname(filePath), this.fileModuleName + '.lua.map');
                }
            }

            const firstFile = !this.sourceMapGenerator;
            this.sourceMapGenerator = this.sourceMapGenerator || new sourceMap.SourceMapGenerator({
                file: path.basename(this.filePathLua),
                sourceRoot: Helpers.cleanUpPath(
                    this.rootFolder || filePath.substr(0, (<any>sourceFile).path.length - sourceFile.fileName.length))
            });

            if (firstFile) {
                (<any>this.sourceMapGenerator).__lastDebugLine = 0;
            }
        }


        this.functionContext.function_or_file_location_node = sourceFile;

        this.sourceFileName = sourceFile.fileName;
        this.processFunctionWithinContext(sourceFile, sourceFile.statements, <any>[], !this.functionContext.environmentCreated, true);
        this.functionContext.environmentCreated = true;
        this.functionContext.is_vararg = true;
    }

    private processBundle(bundle: ts.Bundle): void {
        throw new Error('Method not implemented.');
    }

    private processUnparsedSource(unparsedSource: ts.UnparsedSource): void {
        throw new Error('Method not implemented.');
    }

    private processStatement(node: ts.Statement): void {
        const stackSize = this.markStack();
        this.processStatementInternal(node);
        this.rollbackUnused(stackSize);
    }

    private extraDebugTracePrint(node: ts.Node) {
        let txt = '<no code> ' + ts.SyntaxKind[node.kind];

        try {
            const origin = <ts.Node>(<any>node).__origin;
            if (origin && origin.pos >= 0) {
                txt = origin.getText();
            } else if (node.pos >= 0) {
                txt = node.getText();
            }
        } catch (e) {
        }

        this.extraDebug([
            ts.createStringLiteral(this.functionContext.code.getDebugLine()),
            ts.createStringLiteral(' => '),
            ts.createStringLiteral(txt.substring(0, 140))]);
    }

    private processStatementInternal(nodeIn: ts.Statement): void {
        const node = this.preprocessor.preprocessStatement(nodeIn);

        if (!this.ignoreDebugInfo) {
            this.functionContext.code.setNodeToTrackDebugInfo(node, this.sourceMapGenerator);
        }

        if (this.extraDebugEmbed) {
            this.extraDebugTracePrint(node);
        }

        switch (node.kind) {
            case ts.SyntaxKind.EmptyStatement: return;
            case ts.SyntaxKind.VariableStatement: this.processVariableStatement(<ts.VariableStatement>node); return;
            case ts.SyntaxKind.FunctionDeclaration: this.processFunctionDeclaration(<ts.FunctionDeclaration>node); return;
            case ts.SyntaxKind.Block: this.processBlock(<ts.Block>node); return;
            case ts.SyntaxKind.ModuleBlock: this.processModuleBlock(<ts.ModuleBlock>node); return;
            case ts.SyntaxKind.ReturnStatement: this.processReturnStatement(<ts.ReturnStatement>node); return;
            case ts.SyntaxKind.IfStatement: this.processIfStatement(<ts.IfStatement>node); return;
            case ts.SyntaxKind.DoStatement: this.processDoStatement(<ts.DoStatement>node); return;
            case ts.SyntaxKind.WhileStatement: this.processWhileStatement(<ts.WhileStatement>node); return;
            case ts.SyntaxKind.ForStatement: this.processForStatement(<ts.ForStatement>node); return;
            case ts.SyntaxKind.ForInStatement: this.processForInStatement(<ts.ForInStatement>node); return;
            case ts.SyntaxKind.ForOfStatement: this.processForOfStatement(<ts.ForOfStatement>node); return;
            case ts.SyntaxKind.BreakStatement: this.processBreakStatement(<ts.BreakStatement>node); return;
            case ts.SyntaxKind.ContinueStatement: this.processContinueStatement(<ts.ContinueStatement>node); return;
            case ts.SyntaxKind.SwitchStatement: this.processSwitchStatement(<ts.SwitchStatement>node); return;
            case ts.SyntaxKind.ExpressionStatement: this.processExpressionStatement(<ts.ExpressionStatement>node); return;
            case ts.SyntaxKind.TryStatement: this.processTryStatement(<ts.TryStatement>node); return;
            case ts.SyntaxKind.ThrowStatement: this.processThrowStatement(<ts.ThrowStatement>node); return;
            case ts.SyntaxKind.DebuggerStatement: this.processDebuggerStatement(<ts.DebuggerStatement>node); return;
            case ts.SyntaxKind.EnumDeclaration: this.processEnumDeclaration(<ts.EnumDeclaration>node); return;
            case ts.SyntaxKind.ClassDeclaration: this.processClassDeclaration(<ts.ClassDeclaration>node); return;
            case ts.SyntaxKind.ExportDeclaration: this.processExportDeclaration(<ts.ExportDeclaration>node); return;
            case ts.SyntaxKind.ImportDeclaration: this.processImportDeclaration(<ts.ImportDeclaration>node); return;
            case ts.SyntaxKind.ModuleDeclaration: this.processModuleDeclaration(<ts.ModuleDeclaration>node); return;
            case ts.SyntaxKind.NamespaceExportDeclaration: this.processNamespaceDeclaration(<ts.NamespaceDeclaration>node); return;
            case ts.SyntaxKind.InterfaceDeclaration: /*nothing to do*/ return;
            case ts.SyntaxKind.TypeAliasDeclaration: /*nothing to do*/ return;
            case ts.SyntaxKind.ExportAssignment: /*nothing to do*/ return;
        }

        // TODO: finish it
        throw new Error('Method not implemented.');
    }

    private processExpression(nodeIn: ts.Expression): void {
        const node = this.preprocessor.preprocessExpression(nodeIn);

        // we need to process it for statements only
        //// this.functionContext.code.setNodeToTrackDebugInfo(node, this.sourceMapGenerator);

        switch (node.kind) {
            case ts.SyntaxKind.NewExpression: this.processNewExpression(<ts.NewExpression>node); return;
            case ts.SyntaxKind.CallExpression: this.processCallExpression(<ts.CallExpression>node); return;
            case ts.SyntaxKind.PropertyAccessExpression: this.processPropertyAccessExpression(<ts.PropertyAccessExpression>node); return;
            case ts.SyntaxKind.PrefixUnaryExpression: this.processPrefixUnaryExpression(<ts.PrefixUnaryExpression>node); return;
            case ts.SyntaxKind.PostfixUnaryExpression: this.processPostfixUnaryExpression(<ts.PostfixUnaryExpression>node); return;
            case ts.SyntaxKind.BinaryExpression: this.processBinaryExpression(<ts.BinaryExpression>node); return;
            case ts.SyntaxKind.ConditionalExpression: this.processConditionalExpression(<ts.ConditionalExpression>node); return;
            case ts.SyntaxKind.DeleteExpression: this.processDeleteExpression(<ts.DeleteExpression>node); return;
            case ts.SyntaxKind.TypeOfExpression: this.processTypeOfExpression(<ts.TypeOfExpression>node); return;
            case ts.SyntaxKind.FunctionExpression: this.processFunctionExpression(<ts.FunctionExpression>node); return;
            case ts.SyntaxKind.ArrowFunction: this.processArrowFunction(<ts.ArrowFunction>node); return;
            case ts.SyntaxKind.ElementAccessExpression: this.processElementAccessExpression(<ts.ElementAccessExpression>node); return;
            case ts.SyntaxKind.ParenthesizedExpression: this.processParenthesizedExpression(<ts.ParenthesizedExpression>node); return;
            case ts.SyntaxKind.TypeAssertionExpression: this.processTypeAssertionExpression(<ts.TypeAssertion>node); return;
            case ts.SyntaxKind.VariableDeclarationList: this.processVariableDeclarationList(<ts.VariableDeclarationList><any>node); return;
            case ts.SyntaxKind.TrueKeyword:
            case ts.SyntaxKind.FalseKeyword: this.processBooleanLiteral(<ts.BooleanLiteral>node); return;
            case ts.SyntaxKind.NullKeyword: this.processNullLiteral(<ts.NullLiteral>node); return;
            case ts.SyntaxKind.NumericLiteral: this.processNumericLiteral(<ts.NumericLiteral>node); return;
            case ts.SyntaxKind.StringLiteral: this.processStringLiteral(<ts.StringLiteral>node); return;
            case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
                this.processNoSubstitutionTemplateLiteral(<ts.NoSubstitutionTemplateLiteral>node); return;
            case ts.SyntaxKind.ObjectLiteralExpression: this.processObjectLiteralExpression(<ts.ObjectLiteralExpression>node); return;
            case ts.SyntaxKind.TemplateExpression: this.processTemplateExpression(<ts.TemplateExpression>node); return;
            case ts.SyntaxKind.ArrayLiteralExpression: this.processArrayLiteralExpression(<ts.ArrayLiteralExpression>node); return;
            case ts.SyntaxKind.RegularExpressionLiteral: this.processRegularExpressionLiteral(<ts.RegularExpressionLiteral>node); return;
            case ts.SyntaxKind.ThisKeyword: this.processThisExpression(<ts.ThisExpression>node); return;
            case ts.SyntaxKind.SuperKeyword: this.processSuperExpression(<ts.SuperExpression>node); return;
            case ts.SyntaxKind.VoidExpression: this.processVoidExpression(<ts.VoidExpression>node); return;
            case ts.SyntaxKind.NonNullExpression: this.processNonNullExpression(<ts.NonNullExpression>node); return;
            case ts.SyntaxKind.AsExpression: this.processAsExpression(<ts.AsExpression>node); return;
            case ts.SyntaxKind.SpreadElement: this.processSpreadElement(<ts.SpreadElement>node); return;
            case ts.SyntaxKind.AwaitExpression: this.processAwaitExpression(<ts.AwaitExpression>node); return;
            case ts.SyntaxKind.Identifier: this.processIndentifier(<ts.Identifier>node); return;
        }

        // TODO: finish it
        throw new Error('Method not implemented.');
    }

    private processExpressionStatement(node: ts.ExpressionStatement): void {
        this.processExpression(node.expression);
    }

    private transpileTSNode(node: ts.Node, transformText?: (string) => string) {
        return this.transpileTSCode(node.getFullText(), transformText);
    }

    private transpileTSCode(code: string, transformText?: (string) => string) {

        const opts = {
            module: ts.ModuleKind.CommonJS,
            alwaysStrict: false,
            noImplicitUseStrict: true,
            moduleResolution: ts.ModuleResolutionKind.NodeJs,
            target: ts.ScriptTarget.ES5
        };

        const result = ts.transpileModule(code, { compilerOptions: opts });

        let jsText = result.outputText;
        if (transformText) {
            jsText = transformText(jsText);
        }

        return this.parseJSCode(jsText);
    }

    private parseTSCode(jsText: string) {

        const opts = {
            module: ts.ModuleKind.CommonJS,
            alwaysStrict: false,
            noImplicitUseStrict: true,
            moduleResolution: ts.ModuleResolutionKind.NodeJs,
            target: ts.ScriptTarget.ES5
        };

        const sourceFile = ts.createSourceFile(
            this.sourceFileName, jsText, ts.ScriptTarget.ES5, /*setParentNodes */ true, ts.ScriptKind.TS);
        // nneded to make typeChecker to work properly
        (<any>ts).bindSourceFile(sourceFile, opts);
        return sourceFile.statements;
    }

    private bind(node: ts.Statement) {

        const opts = {
            module: ts.ModuleKind.CommonJS,
            alwaysStrict: false,
            noImplicitUseStrict: true,
            moduleResolution: ts.ModuleResolutionKind.NodeJs,
            target: ts.ScriptTarget.ES5
        };

        const sourceFile = ts.createSourceFile(
            this.sourceFileName, '', ts.ScriptTarget.ES5, /*setParentNodes */ true, ts.ScriptKind.TS);

        (<any>sourceFile.statements) = [node];

        (<any>ts).bindSourceFile(sourceFile, opts);

        return sourceFile.statements[0];
    }

    private parseJSCode(jsText: string) {

        const opts = {
            module: ts.ModuleKind.CommonJS,
            alwaysStrict: false,
            noImplicitUseStrict: true,
            moduleResolution: ts.ModuleResolutionKind.NodeJs,
            target: ts.ScriptTarget.ES5
        };

        const sourceFile = ts.createSourceFile('partial', jsText, ts.ScriptTarget.ES5, /*setParentNodes */ true);
        // nneded to make typeChecker to work properly
        (<any>ts).bindSourceFile(sourceFile, opts);
        return sourceFile.statements;
    }

    private processTSNode(node: ts.Node, transformText?: (string) => string) {
        const statements = this.transpileTSNode(node, transformText);
        statements.forEach(s => {
            this.functionContext.code.setNodeToTrackDebugInfo(node, this.sourceMapGenerator);
            this.ignoreDebugInfo = true;
            this.processStatementInternal(s);
            this.ignoreDebugInfo = false;
        });
    }

    private processTSCode(code: string, parse?: any) {
        const statements = (!parse) ? this.transpileTSCode(code) : this.parseTSCode(code);
        statements.forEach(s => {
            this.ignoreDebugInfo = true;
            this.processStatementInternal(s);
            this.ignoreDebugInfo = false;
        });
    }

    private processJSCode(code: string) {
        const statements = this.parseJSCode(code);
        statements.forEach(s => {
            this.ignoreDebugInfo = true;
            this.processStatementInternal(s);
            this.ignoreDebugInfo = false;
        });
    }

    private processTryStatement(node: ts.TryStatement): void {

        // 1) get method pcall
        // prepare call for _ENV "pcall"
        // prepare consts
        let envInfo = this.resolver.returnResolvedEnv(this.functionContext);
        let pcallMethodInfo = this.resolver.returnConst('pcall', this.functionContext);

        const pcallResultInfo = this.functionContext.useRegisterAndPush();

        envInfo = this.preprocessConstAndUpvalues(envInfo);
        pcallMethodInfo = this.preprocessConstAndUpvalues(pcallMethodInfo);
        // getting method referene
        this.functionContext.code.push(
            [Ops.GETTABUP, pcallResultInfo.getRegister(), envInfo.getRegisterOrIndex(), pcallMethodInfo.getRegisterOrIndex()]);

        this.stackCleanup(pcallMethodInfo);
        this.stackCleanup(envInfo);

        // 2) get closure
        // prepare Closure
        const protoIndex = this.functionContext.createProto(
            this.processFunction(node, node.tryBlock.statements, undefined));
        const closureResultInfo = this.functionContext.useRegisterAndPush();
        this.functionContext.code.push([Ops.CLOSURE, closureResultInfo.getRegister(), protoIndex]);

        // 3) calling closure
        // calling PCall
        this.functionContext.code.push([Ops.CALL, pcallResultInfo.getRegister(), 2, 3]);

        // 4) cleanup
        this.functionContext.stack.pop();
        this.functionContext.stack.pop();

        // creating 2 results
        let statusResultInfo = this.functionContext.useRegisterAndPush();
        statusResultInfo.identifierName = 'status';
        const errorResultInfo = this.functionContext.useRegisterAndPush();
        errorResultInfo.identifierName = 'error';

        // process "finally" block
        if (node.finallyBlock) {
            this.processBlock(node.finallyBlock);
        }

        // process 'catch'
        if (node.catchClause) {
            // if status == true, jump over 'catch'-es.
            // create 'true' boolean
            let resolvedInfo = this.resolver.returnConst(true, this.functionContext);

            statusResultInfo = this.preprocessConstAndUpvalues(statusResultInfo);
            resolvedInfo = this.preprocessConstAndUpvalues(resolvedInfo);

            const equalsTo = 1;
            this.functionContext.code.push([
                Ops.EQ, equalsTo, statusResultInfo.getRegisterOrIndex(), resolvedInfo.getRegisterOrIndex()]);

            this.stackCleanup(resolvedInfo);
            this.stackCleanup(statusResultInfo);

            const jmpOp = [Ops.JMP, 0, 0];
            this.functionContext.code.push(jmpOp);
            const casesBlockBegin = this.functionContext.code.length;

            // scope - begin
            this.functionContext.newLocalScope(node.catchClause);

            const variableDeclaration = node.catchClause.variableDeclaration;
            this.functionContext.createLocal((<ts.Identifier>variableDeclaration.name).text, errorResultInfo);

            node.catchClause.block.statements.forEach(s => {
                this.processStatement(s);
            });

            // scope - end
            this.functionContext.restoreLocalScope();

            // end of cases block
            jmpOp[2] = this.functionContext.code.length - casesBlockBegin;
        }

        // final cleanup error & status
        this.functionContext.stack.pop();
        this.functionContext.stack.pop();
    }

    private processThrowStatement(node: ts.ThrowStatement): void {
        const errorCall = ts.createCall(ts.createIdentifier('error'), undefined, [node.expression]);
        this.processExpression(errorCall);
    }

    private processTypeOfExpression(node: ts.TypeOfExpression): void {
        const typeCall = ts.createCall(ts.createIdentifier('__type'), undefined, [node.expression]);
        typeCall.parent = node;
        this.processExpression(typeCall);
    }

    private processDebuggerStatement(node: ts.DebuggerStatement): void {
        const propertyAccessExpression = ts.createPropertyAccess(ts.createIdentifier('debug'), ts.createIdentifier('debug'));
        const debugCall = ts.createCall(
            propertyAccessExpression,
            undefined,
            []);
        // HACK: to stop applying calling SELF instead of GETTABLE
        /// propertyAccessExpression.parent = debugCall;
        debugCall.parent = node;
        this.processExpression(debugCall);
    }

    private processEnumDeclaration(node: ts.EnumDeclaration): void {
        this.functionContext.newLocalScope(node);
        const properties = [];
        let value = 0;
        for (const member of node.members) {
            if (member.initializer) {
                switch (member.initializer.kind) {
                    case ts.SyntaxKind.NumericLiteral:
                        value = parseInt((<ts.NumericLiteral>member.initializer).text, 10);
                        break;
                    default:
                        throw new Error('Not Implemented');
                }
            } else {
                value++;
            }

            const namedProperty = ts.createPropertyAssignment(
                member.name,
                ts.createNumericLiteral(value.toString()));
            properties.push(namedProperty);

            const valueProperty = ts.createPropertyAssignment(
                ts.createNumericLiteral(value.toString()),
                ts.createStringLiteral((<ts.Identifier>member.name).text));

            properties.push(namedProperty);
            properties.push(valueProperty);
        }

        const prototypeObject = ts.createAssignment(node.name, ts.createObjectLiteral(properties));
        prototypeObject.parent = node;
        this.processExpression(prototypeObject);

        this.emitExport(node.name, node);

        this.functionContext.restoreLocalScope();
    }

    private processClassDeclaration(node: ts.ClassDeclaration): void {
        this.functionContext.newLocalScope(node);

        this.resolver.thisClassName = node.name;
        this.resolver.thisClassType = node;

        // process methods first
        const properties = node.members
            .filter(m => this.isClassMemberAccepted(m)
                && (!this.isPropertyWithNonConstInitializer(m) || this.isPropertyWithArrowFunctionInitializer(m)))
            .map(m => ts.createPropertyAssignment(
                this.getClassMemberName(m),
                this.createClassMember(m)));

        if (this.isDefaultCtorRequired(node)) {
            // create defualt Ctor to initialize readonlys
            this.createDefaultCtor(node, properties);
        }

        // any get accessor
        if (node.members.some(m => m.kind === ts.SyntaxKind.GetAccessor)) {
            this.createAccessorsCollection(node, properties, true);
        }

        // any set accessor
        if (node.members.some(m => m.kind === ts.SyntaxKind.SetAccessor)) {
            this.createAccessorsCollection(node, properties, false);
        }

        // emit __index of base class
        const anyGetStaticAccessor = node.members.some(m => m.kind === ts.SyntaxKind.GetAccessor && this.isStatic(m));
        const anySetStaticAccessor = node.members.some(m => m.kind === ts.SyntaxKind.SetAccessor && this.isStatic(m));
        const extend = this.getInheritanceFirst(node);
        if (extend) {
            properties.push(ts.createPropertyAssignment('__proto', ts.createIdentifier(extend.getText())));
            if (!anyGetStaticAccessor && !anySetStaticAccessor) {
                properties.push(ts.createPropertyAssignment('__index', ts.createIdentifier(extend.getText())));
            }
        }

        if (anyGetStaticAccessor) {
            properties.push(ts.createPropertyAssignment('__index', ts.createIdentifier('__get_static_call__')));
        }

        if (anySetStaticAccessor) {
            properties.push(ts.createPropertyAssignment('__newindex', ts.createIdentifier('__set_static_call__')));
        }

        this.resolver.superClass = extend;

        const prototypeObject = ts.createAssignment(node.name, ts.createObjectLiteral(properties));
        prototypeObject.parent = node;
        this.processExpression(prototypeObject);

        // set metatable for derived class using __index dictionary containing base class
        if (extend || anyGetStaticAccessor || anySetStaticAccessor) {
            const setmetatableCall = ts.createCall(ts.createIdentifier('setmetatable'), undefined, [node.name, node.name]);
            setmetatableCall.parent = node;
            this.processExpression(setmetatableCall);
        }

        // process static members
        // process properties later to allow stitic members to access method in class
        node.members
            .filter(m => this.isClassMemberAccepted(m) && this.isStaticProperty(m) && this.isPropertyWithNonConstInitializer(m))
            .map(m => ts.createAssignment(
                ts.createPropertyAccess(node.name, this.getClassMemberName(m)),
                this.createClassMember(m))).forEach(p => this.processExpression(p));

        this.emitExport(node.name, node);

        this.functionContext.restoreLocalScope();
    }

    private emitExport(name: ts.Identifier, node: ts.Node, fullNamespace?: boolean) {
        const isExport = node.modifiers && node.modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
        if (!isExport) {
            return;
        }

        if (this.functionContext.namespaces.length === 0) {
            const isDefaultExport = node.modifiers && node.modifiers.some(m => m.kind === ts.SyntaxKind.DefaultKeyword);
            if (!isDefaultExport) {
                this.emitGetOrCreateObjectExpression(node, 'exports');
                const setExport = ts.createAssignment(
                    ts.createPropertyAccess(ts.createIdentifier('exports'), !isDefaultExport ? name : 'default'), name);
                this.processExpression(setExport);
            } else {
                // return default value
                const returnDefault = ts.createReturn(name);
                returnDefault.parent = node;
                this.processStatement(returnDefault);
            }

            return;
        }

        // save into module
        this.emitSaveToNamespace(name, fullNamespace);
    }

    private extraDebug(args: ReadonlyArray<ts.Expression>) {
        const extraPrint = ts.createCall(ts.createPropertyAccess(ts.createIdentifier('console'), 'log'), undefined, args);
        const state = this.extraDebugEmbed;
        this.extraDebugEmbed = false;
        this.processExpression(extraPrint);
        this.extraDebugEmbed = state;
    }

    private emitSaveToNamespace(name: ts.Identifier, fullNamespace?: boolean) {
        if (this.functionContext.namespaces.length === 0) {
            return;
        }

        // save into module
        const end = fullNamespace ? 0 : this.functionContext.namespaces.length - 1;

        let propertyAccessExpression;
        for (let i = this.functionContext.namespaces.length - 1; i >= end; i--) {
            const namespaceItem = this.functionContext.namespaces.at(i);
            if (propertyAccessExpression) {
                propertyAccessExpression = ts.createPropertyAccess(propertyAccessExpression, <ts.Identifier>namespaceItem.name);
            } else {
                propertyAccessExpression = ts.createPropertyAccess(namespaceItem.name, name);
            }
        }

        const setModuleExport = ts.createAssignment(propertyAccessExpression, name);
        this.processExpression(setModuleExport);
    }

    private createDefaultCtor(node: ts.ClassDeclaration, properties: ts.PropertyAssignment[]) {
        const defaultCtor = ts.createConstructor(undefined, undefined, [], <ts.Block><any>{
            kind: ts.SyntaxKind.Block,
            statements: []
        });
        defaultCtor.parent = node;
        properties.push(ts.createPropertyAssignment(this.getClassMemberName(defaultCtor), this.createClassMember(defaultCtor)));
    }

    private createAccessorsCollection(node: ts.ClassDeclaration, properties: ts.PropertyAssignment[], isGet: boolean) {
        const accessor = isGet ? ts.SyntaxKind.GetAccessor : ts.SyntaxKind.SetAccessor;
        const memberName = isGet ? '__get__' : '__set__';

        const accessorsProperties = node.members
            .filter(f => f.kind === accessor)
            .map(m => ts.createPropertyAssignment(m.name, this.createClassMember(m)));

        const accessorsMember = ts.createObjectLiteral(accessorsProperties);
        accessorsMember.parent = node;
        properties.push(ts.createPropertyAssignment(memberName, accessorsMember));
    }

    private isDefaultCtorRequired(node: ts.ClassDeclaration) {
        if (node.members.some(m => m.kind === ts.SyntaxKind.Constructor)) {
            return false;
        }

        return node.members.some(m => !this.isStaticProperty(m)
            && this.isPropertyWithNonConstInitializer(m)
            && !this.isPropertyWithArrowFunctionInitializer(m)) ||
            node.members.some(m => m.kind === ts.SyntaxKind.GetAccessor || m.kind === ts.SyntaxKind.SetAccessor);
    }

    private createClassMember(memberDeclaration: ts.ClassElement): ts.Expression {
        switch (memberDeclaration.kind) {
            case ts.SyntaxKind.PropertyDeclaration:
                const propertyDeclaration = <ts.PropertyDeclaration>memberDeclaration;
                return propertyDeclaration.initializer;
            case ts.SyntaxKind.Constructor:
                const constructorDeclaration = <ts.ConstructorDeclaration>memberDeclaration;
                if (!constructorDeclaration.body) {
                    throw 1;
                }
                const constructorFunction = ts.createFunctionExpression(
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    constructorDeclaration.parameters,
                    constructorDeclaration.type, <ts.Block><any>{
                        kind: ts.SyntaxKind.Block,
                        statements: [
                            ...this.getClassInitStepsToSupportGetSetAccessor(memberDeclaration),
                            // initialized members
                            ...(<ts.ClassDeclaration>constructorDeclaration.parent).members
                                .filter(cm => !this.isStaticProperty(cm) && this.isPropertyWithNonConstInitializer(cm))
                                .map(p => ts.createStatement(
                                    ts.createAssignment(
                                        ts.createPropertyAccess(ts.createThis(), <ts.Identifier>p.name),
                                        (<ts.PropertyDeclaration>p).initializer))),
                            // members of class provided in ctor parameters
                            ...constructorDeclaration.parameters
                                .filter(p => p.modifiers && p.modifiers.some(md =>
                                    md.kind === ts.SyntaxKind.PrivateKeyword
                                    || md.kind === ts.SyntaxKind.ProtectedKeyword
                                    || md.kind === ts.SyntaxKind.PublicKeyword))
                                .map(p => ts.createStatement(
                                    ts.createAssignment(
                                        ts.createPropertyAccess(ts.createThis(), <ts.Identifier>p.name),
                                        <ts.Identifier>p.name))),
                            ...constructorDeclaration.body.statements
                        ]
                    });
                (<any>constructorFunction).__origin = constructorDeclaration;
                return constructorFunction;
            case ts.SyntaxKind.SetAccessor:
            case ts.SyntaxKind.GetAccessor:
            case ts.SyntaxKind.MethodDeclaration:
                const methodDeclaration = <ts.MethodDeclaration>memberDeclaration;
                const memberFunction = ts.createFunctionExpression(
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    methodDeclaration.parameters,
                    methodDeclaration.type, <ts.Block><any>{
                        kind: ts.SyntaxKind.Block,
                        statements: methodDeclaration.body.statements
                    });
                (<any>memberFunction).__origin = methodDeclaration;
                return memberFunction;
            default:
                throw new Error('Not Implemented');
        }
    }

    private getClassMemberName(memberDeclaration: ts.ClassElement): string {
        switch (memberDeclaration.kind) {
            case ts.SyntaxKind.Constructor:
                return 'constructor';
            case ts.SyntaxKind.SetAccessor:
                return 'set_' + (<ts.Identifier>memberDeclaration.name).text;
            case ts.SyntaxKind.GetAccessor:
                return 'get_' + (<ts.Identifier>memberDeclaration.name).text;
            default:
                return (<ts.Identifier>memberDeclaration.name).text;
        }
    }

    private isPropertyWithArrowFunctionInitializer(memberDeclaration: ts.ClassElement): any {
        // we do not need - abstract elements
        if (memberDeclaration.kind === ts.SyntaxKind.PropertyDeclaration &&
            (<ts.PropertyDeclaration>memberDeclaration).initializer &&
            (<ts.PropertyDeclaration>memberDeclaration).initializer.kind === ts.SyntaxKind.ArrowFunction) {
            return true;
        }

        return false;
    }

    private isPropertyWithNonConstInitializer(memberDeclaration: ts.ClassElement): any {
        // we do not need - abstract elements
        if (memberDeclaration.kind === ts.SyntaxKind.PropertyDeclaration &&
            (<ts.PropertyDeclaration>memberDeclaration).initializer &&
            !this.isConstExpression((<ts.PropertyDeclaration>memberDeclaration).initializer)) {
            return true;
        }

        return false;
    }

    private isStatic(memberDeclaration: ts.Node): any {
        // we do not need - abstract elements
        if (memberDeclaration.modifiers &&
            memberDeclaration.modifiers.some(modifer => modifer.kind === ts.SyntaxKind.StaticKeyword)) {
            return true;
        }

        return false;
    }

    private isStaticProperty(memberDeclaration: ts.ClassElement): any {
        // we do not need - abstract elements
        if (memberDeclaration.kind === ts.SyntaxKind.PropertyDeclaration &&
            memberDeclaration.modifiers &&
            memberDeclaration.modifiers.some(modifer => modifer.kind === ts.SyntaxKind.StaticKeyword)) {
            return true;
        }

        return false;
    }

    private isConstExpression(expression: ts.Expression): any {
        // we do not need - abstract elements
        switch (expression.kind) {
            case ts.SyntaxKind.TrueKeyword:
            case ts.SyntaxKind.FalseKeyword:
            case ts.SyntaxKind.NumericLiteral:
            case ts.SyntaxKind.StringLiteral:
            case ts.SyntaxKind.NullKeyword:
                return true;
        }

        return false;
    }

    private isClassMemberAccepted(memberDeclaration: ts.ClassElement): any {
        // we do not need - abstract elements
        if (memberDeclaration.modifiers &&
            memberDeclaration.modifiers.some(modifer => modifer.kind === ts.SyntaxKind.AbstractKeyword)) {
            return false;
        }

        switch (memberDeclaration.kind) {
            case ts.SyntaxKind.PropertyDeclaration:
                const propertyDeclaration = <ts.PropertyDeclaration>memberDeclaration;
                return propertyDeclaration.initializer;
            case ts.SyntaxKind.Constructor:
            case ts.SyntaxKind.MethodDeclaration:
                const methodDeclaration = <ts.MethodDeclaration>memberDeclaration;
                return methodDeclaration.body;
            case ts.SyntaxKind.GetAccessor:
            case ts.SyntaxKind.SetAccessor:
            case ts.SyntaxKind.SemicolonClassElement:
                return false;
            case ts.SyntaxKind.IndexSignature:
                // TODO: investigate implementatino of '[index: number]: T;'
                return false;
            default:
                throw new Error('Not Implemented');
        }
    }

    private getClassInitStepsToSupportGetSetAccessor(memberDeclaration: ts.ClassElement): any {
        const statements = [];
        const node = <ts.ClassDeclaration>memberDeclaration.parent;
        const anyGet = node.members.some(m => m.kind === ts.SyntaxKind.GetAccessor && !this.isStatic(m));
        const anySet = node.members.some(m => m.kind === ts.SyntaxKind.SetAccessor && !this.isStatic(m));
        if (!anyGet && !anySet) {
            return statements;
        }

        if (anyGet) {
            statements.push(ts.createStatement(
                ts.createAssignment(
                    ts.createPropertyAccess(ts.createThis(), '__index'),
                    ts.createIdentifier('__get_call__'))));
        }

        if (anySet) {
            statements.push(ts.createStatement(
                ts.createAssignment(
                    ts.createPropertyAccess(ts.createThis(), '__newindex'),
                    ts.createIdentifier('__set_call__'))));
        }

        return statements;
    }

    private getInheritanceFirst(node: ts.ClassDeclaration): ts.Identifier {
        if (!node.heritageClauses) {
            return;
        }

        let extend: ts.Identifier;
        node.heritageClauses.filter(hc => hc.token === ts.SyntaxKind.ExtendsKeyword).forEach(heritageClause => {
            heritageClause.types.forEach(type => {
                if (!extend) {
                    extend = <ts.Identifier>type.expression;
                }
            });
        });

        return extend;
    }

    private processModuleDeclaration(node: ts.ModuleDeclaration): void {
        const isModuleDeclaratino = node.modifiers && node.modifiers.some(m => m.kind === ts.SyntaxKind.DeclareKeyword);
        if (isModuleDeclaratino) {
            return;
        }

        this.functionContext.namespaces.push(node);

        this.emitGetOrCreateObjectExpression(node, node.name.text);
        if (node.body) {
            this.processStatement(<ts.ModuleBlock>node.body);
        }

        this.functionContext.namespaces.pop();

        this.emitSaveToNamespace(<ts.Identifier>node.name);
    }

    private processNamespaceDeclaration(node: ts.NamespaceDeclaration): void {
        this.processModuleDeclaration(node);
    }

    private processExportDeclaration(node: ts.ExportDeclaration): void {
        this.functionContext.newLocalScope(node);

        this.emitGetOrCreateObjectExpression(node, 'exports');

        this.processTSNode(node);
        this.functionContext.restoreLocalScope();
    }

    private processImportDeclaration(node: ts.ImportDeclaration): void {
        // copy exported references from 'exports' object
        if (node.importClause) {
            if (node.importClause.namedBindings) {
                // 1) require './<nodule>'
                const requireCall = ts.createCall(ts.createIdentifier('require'), /*typeArguments*/ undefined, [node.moduleSpecifier]);
                requireCall.parent = node;
                this.processExpression(requireCall);

                switch (node.importClause.namedBindings.kind) {
                    case ts.SyntaxKind.NamespaceImport:
                        const name = node.importClause.namedBindings.name;
                        const assignOfNamespaceImport = ts.createAssignment(
                            name,
                            ts.createIdentifier('exports'));
                        assignOfNamespaceImport.parent = node;
                        this.processExpression(assignOfNamespaceImport);
                        break;
                    case ts.SyntaxKind.NamedImports:
                        const namedImports = <ts.NamedImports>node.importClause.namedBindings;
                        namedImports.elements.forEach(imp => {
                            const assignOfImport = ts.createAssignment(
                                imp.name,
                                ts.createPropertyAccess(ts.createIdentifier('exports'), imp.propertyName || imp.name));
                            assignOfImport.parent = node;
                            this.processExpression(assignOfImport);
                        });
                        break;
                    default:
                        throw new Error('Not Implemented');
                }
            } else {
                // 1) require './<nodule>'
                // const requireCall2 = ts.createCall(ts.createIdentifier('require'), /*typeArguments*/ undefined, [node.moduleSpecifier]);
                // requireCall2.parent = node;
                // this.processExpression(requireCall2);

                // // default case
                // const assignOfImport = ts.createAssignment(
                //     node.importClause.name,
                //     ts.createElementAccess(ts.createIdentifier('exports'), ts.createStringLiteral('default')));
                // assignOfImport.parent = node;
                // this.processExpression(assignOfImport);

                const requireCall2 = ts.createCall(ts.createIdentifier('require'), /*typeArguments*/ undefined, [node.moduleSpecifier]);

                const assignOfImport = ts.createAssignment(
                    node.importClause.name,
                    requireCall2);
                assignOfImport.parent = node;
                requireCall2.parent = assignOfImport;
                this.processExpression(assignOfImport);
            }
        } else {
            const requireCall3 = ts.createCall(ts.createIdentifier('require'), /*typeArguments*/ undefined, [node.moduleSpecifier]);
            requireCall3.parent = node;
            this.processExpression(requireCall3);
        }
    }

    private processVariableDeclarationList(declarationList: ts.VariableDeclarationList): void {
        declarationList.declarations.forEach(
            d => this.processVariableDeclarationOne((<ts.Identifier>d.name).text, d.initializer, Helpers.isConstOrLet(declarationList)));
    }

    private processVariableDeclarationOne(name: string, initializer: ts.Expression, isLetOrConst: boolean) {
        const localVar = this.functionContext.findScopedLocal(name, true);
        if (isLetOrConst && localVar === -1) {
            const localVarRegisterInfo = this.functionContext.createLocal(name);
            if (initializer) {
                this.processExpression(initializer);
            } else {
                this.processNullLiteral(null);
            }

            const rightNode = this.functionContext.stack.pop();
            this.functionContext.code.push([Ops.MOVE, localVarRegisterInfo.getRegister(), rightNode.getRegister()]);
        } else if (localVar !== -1) {
            if (initializer) {
                const localVarRegisterInfo = this.resolver.returnLocal(name, this.functionContext);
                this.processExpression(initializer);
                const rightNode = this.functionContext.stack.pop();
                this.functionContext.code.push([Ops.MOVE, localVarRegisterInfo.getRegister(), rightNode.getRegister()]);
            }
        } else {
            if (initializer) {
                this.processExpression(initializer);
                this.emitStoreToEnvObjectProperty(this.resolver.returnIdentifier(name, this.functionContext));
            }
        }
    }

    private processVariableStatement(node: ts.VariableStatement): void {
        this.processVariableDeclarationList(node.declarationList);
    }

    private emitStoreToEnvObjectProperty(nameConstIndex: ResolvedInfo) {
        nameConstIndex = this.preprocessConstAndUpvalues(nameConstIndex);
        this.stackCleanup(nameConstIndex);

        const resolvedInfo = this.functionContext.stack.pop().optimize();

        this.functionContext.code.push([
            Ops.SETTABUP,
            this.resolver.returnResolvedEnv(this.functionContext).getRegisterOrIndex(),
            nameConstIndex.getRegisterOrIndex(),
            resolvedInfo.getRegisterOrIndex()]);
    }

    private processFunctionExpression(node: ts.FunctionExpression): void {
        if (!node.body) {
            // this is declaration
            return;
        }

        const protoIndex = this.functionContext.createProto(
            this.processFunction(node, node.body.statements, node.parameters));
        const resultInfo = this.functionContext.useRegisterAndPush();
        this.functionContext.code.push([Ops.CLOSURE, resultInfo.getRegister(), protoIndex]);
    }

    private processArrowFunction(node: ts.ArrowFunction): void {
        if (node.body.kind !== ts.SyntaxKind.Block) {
            // create body
            node.body = ts.createBlock([ts.createReturn(<ts.Expression>node.body)]);
        }

        this.processFunctionExpression(<any>node);
    }

    private processFunctionDeclaration(node: ts.FunctionDeclaration): void {
        if (node.modifiers && node.modifiers.some(m => m.kind === ts.SyntaxKind.DeclareKeyword)) {
            // skip it, as it is only declaration
            return;
        }

        this.processFunctionExpression(<ts.FunctionExpression><any>node);

        this.emitStoreToEnvObjectProperty(this.resolver.returnIdentifier(node.name.text, this.functionContext));

        this.emitExport(node.name, node);
    }

    private processReturnStatement(node: ts.ReturnStatement): void {
        if (node.expression) {
            this.processExpression(node.expression);
            const resultInfo = this.functionContext.stack.pop();

            // support custom return size
            const ret = this.GetVariableReturn();

            let returnValues = 1;
            if (ret) {
                // tslint:disable-next-line:radix
                returnValues = parseInt(
                    (<ts.Identifier>(<ts.CallExpression>(ret.expression)).arguments[0]).text);
            }

            this.functionContext.code.push(
                [Ops.RETURN, resultInfo.getRegister(), returnValues + 1]);
        } else {
            this.functionContext.code.push([Ops.RETURN, 0, 1]);
        }
    }

    private GetVariableReturn() {
        const location = this.functionContext.current_location_node;
        const ret = location && location.decorators && location.decorators.find(m => m.expression.kind === ts.SyntaxKind.CallExpression
            && (<ts.Identifier>((<ts.CallExpression>m.expression).expression)).text === 'ret');
        return ret;
    }

    private processIfStatement(node: ts.IfStatement): void {
        this.processExpression(node.expression);

        const equalsTo = 0;
        const ifExptNode = this.functionContext.stack.pop().optimize();

        const testSetOp = [Ops.TEST, ifExptNode.getRegisterOrIndex(), equalsTo];
        this.functionContext.code.push(testSetOp);

        const jmpOp = [Ops.JMP, 0, 1];
        this.functionContext.code.push(jmpOp);

        const beforeBlock = this.functionContext.code.length;

        this.processStatement(node.thenStatement);

        let jmpElseOp;
        let elseBlock;
        if (node.elseStatement) {
            jmpElseOp = [Ops.JMP, 0, 1];
            this.functionContext.code.push(jmpElseOp);

            elseBlock = this.functionContext.code.length;
        }

        jmpOp[2] = this.functionContext.code.length - beforeBlock;

        if (node.elseStatement) {
            this.processStatement(node.elseStatement);
            jmpElseOp[2] = this.functionContext.code.length - elseBlock;
        }
    }

    private processDoStatement(node: ts.DoStatement): void {
        this.emitLoop(node.expression, node);
    }

    private processWhileStatement(node: ts.WhileStatement): void {
        // jump to expression
        const jmpOp = [Ops.JMP, 0, 0];
        this.functionContext.code.push(jmpOp);

        const beforeBlock = this.functionContext.code.length;

        jmpOp[2] = this.emitLoop(node.expression, node) - beforeBlock;
    }

    private processForStatement(node: ts.ForStatement): void {

        this.functionContext.newLocalScope(node);

        this.declareLoopVariables(<ts.Expression>node.initializer);

        // jump to expression
        const jmpOp = [Ops.JMP, 0, 0];
        this.functionContext.code.push(jmpOp);

        const beforeBlock = this.functionContext.code.length;

        jmpOp[2] = this.emitLoop(node.condition, node, node.incrementor) - beforeBlock;

        this.functionContext.restoreLocalScope();
    }

    private declareLoopVariables(initializer: ts.Expression) {
        if (initializer) {
            if (initializer.kind === ts.SyntaxKind.Identifier) {
                this.processVariableDeclarationOne(initializer.getText(), undefined, true);
            } else {
                this.processExpression(<ts.Expression>initializer);
            }
        }
    }

    private markStack(): number {
        return this.functionContext.stack.getLength();
    }

    private rollbackUnused(stack: number) {
        if (stack < this.functionContext.stack.getLength()) {
            // we need to remove unused value
            this.functionContext.stack.pop();
        }
    }

    private emitLoop(expression: ts.Expression, node: ts.IterationStatement, incrementor?: ts.Expression): number {

        this.functionContext.newBreakContinueScope();

        const beforeBlock = this.functionContext.code.length;

        this.processStatement(node.statement);

        this.resolveContinueJumps();

        if (incrementor) {
            const stackSize = this.markStack();
            this.processExpression(incrementor);
            this.rollbackUnused(stackSize);
        }

        const expressionBlock = this.functionContext.code.length;

        if (expression) {
            this.processExpression(expression);

            const ifExptNode = this.functionContext.stack.pop().optimize();

            const equalsTo = 1;
            const testSetOp = [Ops.TEST, ifExptNode.getRegisterOrIndex(), 0 /*unused*/, equalsTo];
            this.functionContext.code.push(testSetOp);
        }

        const jmpOp = [Ops.JMP, 0, beforeBlock - this.functionContext.code.length - 1];
        this.functionContext.code.push(jmpOp);

        this.resolveBreakJumps();
        this.functionContext.restoreBreakContinueScope();

        return expressionBlock;
    }

    private processForInStatement(node: ts.ForInStatement): void {
        this.functionContext.newLocalScope(node);
        this.processForInStatementNoScope(node);
        this.functionContext.restoreLocalScope();
    }

    private processForInStatementNoScope(node: ts.ForInStatement): void {

        this.functionContext.newBreakContinueScope();

        // we need to generate 3 local variables for ForEach loop
        const generatorInfo = this.functionContext.createLocal('<generator>');
        const stateInfo = this.functionContext.createLocal('<state>');
        const controlInfo = this.functionContext.createLocal('<control>');

        const isLocalOrConstDecl =
            ((<ts.Expression>node.initializer).kind === ts.SyntaxKind.VariableDeclarationList
                && Helpers.isConstOrLet(<ts.VariableDeclarationList>node.initializer))
            || ((<ts.Expression>node.initializer).kind === ts.SyntaxKind.Identifier
                && this.resolver.resolver(<ts.Identifier>node.initializer, this.functionContext).isLocal());

        this.functionContext.createLocal('<var>');
        if (isLocalOrConstDecl) {
            // if iterator variable is not local then we need to save local variable into
            // initializer
            this.declareLoopVariables(<ts.Expression>node.initializer);
        }

        // call PAIRS(...) before jump
        // TODO: finish it
        this.processExpression(node.expression);

        let iterator = 'pairs';
        if (this.typeInfo.isTypesOfNode(node.expression, ['Array', 'tuple', 'anonymous'])) {
            iterator = 'ipairs';
        }

        // prepare call for _ENV "pairs"
        // prepare consts
        const envInfo = this.resolver.returnResolvedEnv(this.functionContext);
        const pairsMethodInfo = this.resolver.returnConst(iterator, this.functionContext);

        const expressionResultInfo = this.functionContext.stack.peek();
        // getting method referene
        this.functionContext.code.push(
            [Ops.GETTABUP, generatorInfo.getRegister(), envInfo.getRegisterOrIndex(), pairsMethodInfo.getRegisterOrIndex()]);

        // first parameter of method call "pairs"
        if (expressionResultInfo.getRegisterOrIndex() < 0) {
            this.functionContext.code.push(
                [Ops.LOADK, stateInfo.getRegister(), expressionResultInfo.getRegisterOrIndex()]);
        } else {
            this.functionContext.code.push(
                [Ops.MOVE, stateInfo.getRegister(), expressionResultInfo.getRegisterOrIndex()]);
        }

        // finally - calling method 'pairs'
        this.functionContext.code.push(
            [Ops.CALL, generatorInfo.getRegister(), 2, 4]);

        // cleaning up stack, first parameter, method ref, and expression
        this.functionContext.stack.pop();

        // jump to expression
        const initialJmpOp = [Ops.JMP, 0, 0];
        this.functionContext.code.push(initialJmpOp);

        const beforeBlock = this.functionContext.code.length;

        // save <var> into local
        // get last identifier
        let forInIdentifier: ts.Identifier;
        if ((<ts.Expression>node.initializer).kind === ts.SyntaxKind.VariableDeclarationList) {
            const decls = (<ts.VariableDeclarationList>node.initializer).declarations;
            forInIdentifier = <ts.Identifier>decls[decls.length - 1].name;
        } else if ((<ts.Expression>node.initializer).kind === ts.SyntaxKind.Identifier) {
            forInIdentifier = <ts.Identifier>node.initializer;
        } else {
            throw new Error('Not Implemented');
        }

        const assignmentOperation = ts.createAssignment(
            forInIdentifier,
            ts.createConditional(
                ts.createBinary(
                    ts.createTypeOf(ts.createIdentifier('<var>')),
                    ts.SyntaxKind.EqualsEqualsToken,
                    ts.createStringLiteral('number')),
                ts.createSubtract(ts.createIdentifier('<var>'), ts.createNumericLiteral('1')),
                ts.createIdentifier('<var>')));
        assignmentOperation.parent = node;
        this.processExpression(assignmentOperation);

        // loop
        this.processStatement(node.statement);

        const loopOpsBlock = this.functionContext.code.length;

        this.resolveContinueJumps();

        const tforCallOp = [Ops.TFORCALL, generatorInfo.getRegister(), 0, 1];
        this.functionContext.code.push(tforCallOp);

        // replace with TFORLOOP
        const tforLoopOp = [Ops.TFORLOOP, controlInfo.getRegister(), beforeBlock - this.functionContext.code.length - 1];
        this.functionContext.code.push(tforLoopOp);

        // storing jump address
        initialJmpOp[2] = loopOpsBlock - beforeBlock;

        this.resolveBreakJumps();

        // clean temp local variable
        if (!isLocalOrConstDecl) {
            this.functionContext.stack.pop();
        }

        this.functionContext.restoreBreakContinueScope();
    }

    private processForOfStatement(node: ts.ForOfStatement): void {

        const expressionType = this.typeInfo.getTypeOfNode(node.expression);

        // we need to find out type of element
        const typeOfExpression = this.resolver.getTypeAtLocation(node.expression);
        const typeOfElement =
            typeOfExpression.typeArguments
            && typeOfExpression.typeArguments[0]
            && typeOfExpression.typeArguments[0];
        let typeNode;
        if (typeOfElement) {
            const typeName = this.typeInfo.getNameFromTypeNode(typeOfElement);
            typeNode = ts.createTypeReferenceNode(typeName, undefined);
        }

        const indexerName = 'i_';
        const indexerExpr = ts.createIdentifier(indexerName);
        // it is needed to detect type of local variable to support preprocessing correctly
        (<any>indexerExpr).__return_type = 'number';
        const declIndexer = ts.createVariableDeclaration(indexerName, undefined, ts.createNumericLiteral('0'));
        const arrayItem = <ts.Identifier>(<ts.VariableDeclarationList>node.initializer).declarations[0].name;
        const arrayAccess = ts.createElementAccess(node.expression, indexerExpr);
        const arrayItemInitialization = ts.createVariableDeclaration(
            arrayItem, typeNode, arrayAccess);

        arrayAccess.parent = arrayItemInitialization;

        const newStatementBlockWithElementAccess = ts.createBlock(
            [
                ts.createVariableStatement(
                    undefined,
                    ts.createVariableDeclarationList(
                        [arrayItemInitialization],
                        node.initializer.flags/*ts.NodeFlags.Const*/)),
                node.statement
            ]);

        const lengthMemeber = ts.createIdentifier('length');
        if (expressionType === 'string') {
            (<any>lengthMemeber).__len = true;
        }

        const forStatement =
            ts.createFor(ts.createVariableDeclarationList([declIndexer], ts.NodeFlags.Const),
                ts.createBinary(
                    indexerExpr,
                    ts.SyntaxKind.LessThanToken, ts.createPropertyAccess(node.expression, lengthMemeber)),
                ts.createPostfixIncrement(indexerExpr),
                newStatementBlockWithElementAccess);

        forStatement.parent = node.parent;
        (<any>forStatement).__origin = node;

        // TODO: if you bind here, you will loose binding in not changes nodes, find out how to avoid it

        this.processStatement(forStatement);
    }

    private processBreakStatement(node: ts.BreakStatement) {
        const breakJmpOp = [Ops.JMP, 0, 0];
        this.functionContext.code.push(breakJmpOp);
        this.functionContext.breaks.push(this.functionContext.code.length - 1);
    }

    private resolveBreakJumps(jump?: number) {
        this.functionContext.breaks.forEach(b => {
            this.functionContext.code.codeAt(b)[2] = (jump ? jump : this.functionContext.code.length) - b - 1;
        });

        this.functionContext.breaks = [];
    }

    private processContinueStatement(node: ts.ContinueStatement) {
        const continueJmpOp = [Ops.JMP, 0, 0];
        this.functionContext.code.push(continueJmpOp);
        this.functionContext.continues.push(this.functionContext.code.length - 1);
    }

    private resolveContinueJumps(jump?: number) {
        this.functionContext.continues.forEach(c => {
            this.functionContext.code.codeAt(c)[2] = (jump ? jump : this.functionContext.code.length) - c - 1;
        });

        this.functionContext.continues = [];
    }

    private processSwitchStatement(node: ts.SwitchStatement) {
        this.processExpression(node.expression);

        this.functionContext.newLocalScope(node);

        this.functionContext.newBreakContinueScope();

        const switchResultInfo = this.functionContext.stack.peek();

        let previousCaseJmpIndex = -1;
        let lastCaseJmpIndexes: number[] = [];
        node.caseBlock.clauses.forEach(c => {

            // set jump for previouse 'false' case;
            if (previousCaseJmpIndex !== -1) {
                if (this.functionContext.code.codeAt(previousCaseJmpIndex)[2] !== 0) {
                    throw new Error('Jump is set already');
                }

                this.functionContext.code.codeAt(previousCaseJmpIndex)[2] = this.functionContext.code.length - previousCaseJmpIndex - 1;
                previousCaseJmpIndex = -1;
            }

            if (c.kind === ts.SyntaxKind.CaseClause) {
                // process 'case'
                const caseClause = <ts.CaseClause>c;
                this.processExpression(caseClause.expression);

                const caseResultInfo = this.functionContext.stack.pop().optimize();

                const equalsTo = 1;
                this.functionContext.code.push([
                    Ops.EQ, equalsTo, switchResultInfo.getRegisterOrIndex(), caseResultInfo.getRegisterOrIndex()]);
                const jmpOp = [Ops.JMP, 0, 0];
                this.functionContext.code.push(jmpOp);
                lastCaseJmpIndexes.push(this.functionContext.code.length - 1);
            }

            if (c.statements.length > 0) {
                if (c.kind === ts.SyntaxKind.CaseClause) {
                    // jump over the case
                    const jmpOp = [Ops.JMP, 0, 0];
                    this.functionContext.code.push(jmpOp);
                    previousCaseJmpIndex = this.functionContext.code.length - 1;
                }

                // set jump to body of the case
                lastCaseJmpIndexes.forEach(j => {
                    if (this.functionContext.code.codeAt(j)[2] !== 0) {
                        throw new Error('Jump is set already');
                    }

                    this.functionContext.code.codeAt(j)[2] = this.functionContext.code.length - j - 1;
                });

                lastCaseJmpIndexes = [];
            }

            // case or default body
            c.statements.forEach(s => this.processStatement(s));
        });

        this.functionContext.restoreLocalScope();

        this.functionContext.stack.pop();

        // clearup switch result;
        this.resolveBreakJumps();

        this.functionContext.restoreBreakContinueScope();
    }

    private processBlock(node: ts.Block): void {

        this.functionContext.newLocalScope(node);

        node.statements.forEach(s => {
            this.processStatement(s);
        });

        this.functionContext.restoreLocalScope();
    }

    private processModuleBlock(node: ts.ModuleBlock): void {

        this.functionContext.newLocalScope(node);

        node.statements.forEach(s => {
            this.processStatement(s);
        });

        this.functionContext.restoreLocalScope();
    }

    private processBooleanLiteral(node: ts.BooleanLiteral): void {
        const boolValue = node.kind === ts.SyntaxKind.TrueKeyword;
        const opCode = [Ops.LOADBOOL, this.functionContext.useRegisterAndPush().getRegister(), boolValue ? 1 : 0, 0];
        this.functionContext.code.push(opCode);
    }

    private processNullLiteral(node: ts.NullLiteral): void {
        const resultInfo = this.functionContext.useRegisterAndPush();
        // LOADNIL A B     R(A), R(A+1), ..., R(A+B) := nil
        this.functionContext.code.push([Ops.LOADNIL, resultInfo.getRegister(), 0]);
    }

    private processNumericLiteral(node: ts.NumericLiteral): void {
        this.emitNumericConst(node.text);
    }

    private emitNumericConst(text: string): void {
        const resultInfo = this.functionContext.useRegisterAndPush();
        const resolvedInfo = this.resolver.returnConst(
            text.indexOf('.') === -1 ? parseInt(text, 10) : parseFloat(text), this.functionContext);
        // LOADK A Bx    R(A) := Kst(Bx)
        this.functionContext.code.push([Ops.LOADK, resultInfo.getRegister(), resolvedInfo.getRegisterOrIndex()]);
    }

    private processStringLiteral(node: ts.StringLiteral): void {
        const resultInfo = this.functionContext.useRegisterAndPush();
        const resolvedInfo = this.resolver.returnConst(node.text, this.functionContext);
        // LOADK A Bx    R(A) := Kst(Bx)
        this.functionContext.code.push([Ops.LOADK, resultInfo.getRegister(), resolvedInfo.getRegisterOrIndex()]);
    }

    private processNoSubstitutionTemplateLiteral(node: ts.NoSubstitutionTemplateLiteral): void {
        this.processStringLiteral(<ts.StringLiteral><any>node);
    }

    private processTemplateExpression(node: ts.TemplateExpression): void {
        this.processTSNode(node);
    }

    private processRegularExpressionLiteral(node: ts.RegularExpressionLiteral): void {
        const identifier = ts.createIdentifier('RegExp');
        const index = node.text.lastIndexOf('/');
        const arg1 = index >= 0 ? node.text.substr(1, index - 1) : node.text;
        const arg2 = index >= 0 ? node.text.substr(index + 1) : '';
        let expr;
        if (arg2 !== '') {
            expr = ts.createNew(identifier, undefined, [ts.createStringLiteral(arg1), ts.createStringLiteral(arg2)]);
        } else {
            expr = ts.createNew(identifier, undefined, [ts.createStringLiteral(arg1)]);
        }

        expr.parent = node;
        this.processNewExpression(expr);
    }

    private processObjectLiteralExpression(node: ts.ObjectLiteralExpression): void {
        const resultInfo = this.functionContext.useRegisterAndPush();
        this.functionContext.code.push([
            Ops.NEWTABLE,
            resultInfo.getRegister(),
            node.properties.length,
            0]);

        node.properties.filter(e => e.kind !== ts.SyntaxKind.SpreadAssignment).forEach((e: ts.ObjectLiteralElementLike, index: number) => {
            // set 0 element
            this.resolver.Scope.push(node);
            this.processExpression(<ts.Expression><any>e.name);
            this.resolver.Scope.pop();

            // we need to remove scope as expression is not part of object
            if (e.kind === ts.SyntaxKind.ShorthandPropertyAssignment) {
                this.processExpression(<ts.Expression><any>e.name);
            } else if (e.kind === ts.SyntaxKind.PropertyAssignment) {
                this.processExpression(e.initializer);
            } else {
                throw new Error('Not Implemented');
            }

            const propertyValueInfo = this.functionContext.stack.pop().optimize();
            const propertyIndexInfo = this.functionContext.stack.pop().optimize();

            this.functionContext.code.push(
                [Ops.SETTABLE,
                resultInfo.getRegister(),
                propertyIndexInfo.getRegisterOrIndex(),
                propertyValueInfo.getRegisterOrIndex()]);
        });

        node.properties.filter(e => e.kind === ts.SyntaxKind.SpreadAssignment).forEach((e: ts.ObjectLiteralElementLike, index: number) => {
            // creating foreach loop for each spread object
            const spreadAssignment = <ts.SpreadAssignment>e;

            const objLocal = ts.createIdentifier('obj_');
            objLocal.flags = ts.NodeFlags.Const;
            const indexLocal = ts.createIdentifier('i_');
            const forInSetStatement = ts.createForIn(
                ts.createVariableDeclarationList([ts.createVariableDeclaration(indexLocal)], ts.NodeFlags.Const),
                spreadAssignment.expression,
                ts.createStatement(ts.createAssignment(
                    ts.createElementAccess(objLocal, indexLocal),
                    ts.createElementAccess(spreadAssignment.expression, indexLocal))));
            forInSetStatement.parent = node;
            // this is important call to allow to resolve local variables
            // TODO: but it does not work here, why?
            // this.bind(forInSetStatement);

            this.functionContext.newLocalScope(forInSetStatement);
            this.functionContext.createLocal('obj_', resultInfo);
            this.processForInStatementNoScope(forInSetStatement);
            this.functionContext.restoreLocalScope();
        });
    }

    private processArrayLiteralExpression(node: ts.ArrayLiteralExpression): void {

        const initializeArrayFunction = (arrayRef: ResolvedInfo) => {
            if (node.elements.length > 0) {
                const isFirstElementSpread = node.elements[0].kind === ts.SyntaxKind.SpreadElement;
                const isLastFunctionCall = node.elements[node.elements.length - 1].kind === ts.SyntaxKind.CallExpression;
                const isSpreadElementOrMethodCall = isFirstElementSpread || isLastFunctionCall;

                // set 0|1.. elements
                const reversedValues = node.elements.slice(0);
                if (reversedValues.length > 0) {
                    reversedValues.forEach((e, index: number) => {
                        this.processExpression(e);
                    });

                    reversedValues.forEach(a => {
                        // pop method arguments
                        this.functionContext.stack.pop();
                    });

                    if (node.elements.length > 511) {
                        throw new Error('finish using C in SETLIST');
                    }

                    this.functionContext.code.push(
                        [Ops.SETLIST, arrayRef.getRegister(), isSpreadElementOrMethodCall ? 0 : reversedValues.length, 1]);
                }

                if (!this.jsLib) {
                    this.AddLengthToConstArray(arrayRef.getRegisterOrIndex());
                }
            }
        };

        let resultInfo;
        if (this.jsLib) {
            const newArray = ts.createNew(ts.createIdentifier('Array'), undefined, []);
            this.processNewExpression(newArray, initializeArrayFunction);
            resultInfo = this.functionContext.stack.peek();
        } else {
            resultInfo = this.functionContext.useRegisterAndPush();
            this.functionContext.code.push([
                Ops.NEWTABLE,
                resultInfo.getRegister(),
                node.elements.length,
                0]);
            initializeArrayFunction(resultInfo);
        }
    }

    private processElementAccessExpression(node: ts.ElementAccessExpression): void {
        this.processExpression(node.expression);
        this.processExpression(node.argumentExpression);

        if (this.typeInfo.isTypesOfNode(node.expression, ['Array', 'tuple', 'any'])) {
            // add +1 if number
            const op1 = this.functionContext.stack.peek();

            this.functionContext.newLocalScope(node);

            this.functionContext.createLocal('<op1>', op1);
            const localOp1Ident = ts.createIdentifier('<op1>');

            const condition = ts.createBinary(
                        ts.createTypeOf(localOp1Ident), ts.SyntaxKind.EqualsEqualsToken, ts.createStringLiteral('number'));

            const condExpression = ts.createConditional(condition,
                ts.createBinary(localOp1Ident, ts.SyntaxKind.PlusToken, ts.createNumericLiteral('1')), localOp1Ident);
            condExpression.parent = node;
            condition.parent = condExpression;
            this.processExpression(condExpression);

            this.functionContext.restoreLocalScope();

            const result = this.functionContext.stack.pop();
            this.functionContext.code.push([
                Ops.MOVE,
                op1.getRegister(),
                result.getRegister(),
                0]);
            // end of adding +1 if number
        }

        // perform load
        const indexInfo = this.functionContext.stack.pop().optimize();
        const variableInfo = this.functionContext.stack.pop().optimize();

        const resultInfo = this.functionContext.useRegisterAndPush();
        this.functionContext.code.push(
            [Ops.GETTABLE,
            resultInfo.getRegister(),
            variableInfo.getRegisterOrIndex(),
            indexInfo.getRegisterOrIndex()]);
    }

    private processParenthesizedExpression(node: ts.ParenthesizedExpression) {
        this.processExpression(node.expression);
    }

    private processTypeAssertionExpression(node: ts.TypeAssertion) {
        this.processExpression(node.expression);
    }

    private processPrefixUnaryExpression(node: ts.PrefixUnaryExpression): void {
        let opCode;
        switch (node.operator) {
            case ts.SyntaxKind.MinusToken:
            case ts.SyntaxKind.TildeToken:
            case ts.SyntaxKind.ExclamationToken:
                switch (node.operator) {
                    case ts.SyntaxKind.MinusToken:
                        opCode = Ops.UNM;
                        break;
                    case ts.SyntaxKind.TildeToken:
                        opCode = Ops.BNOT;
                        break;
                    case ts.SyntaxKind.ExclamationToken:
                        opCode = Ops.NOT;
                        break;
                }

                this.processExpression(node.operand);

                // no optimization required as expecting only Registers
                const rightNode = this.functionContext.stack.pop();
                const resultInfo = this.functionContext.useRegisterAndPush();

                this.functionContext.code.push([
                    opCode,
                    resultInfo.getRegister(),
                    rightNode.getRegisterOrIndex()]);
                break;

            case ts.SyntaxKind.PlusPlusToken:
            case ts.SyntaxKind.MinusMinusToken:
                switch (node.operator) {
                    case ts.SyntaxKind.PlusPlusToken:
                        opCode = Ops.ADD;
                        break;
                    case ts.SyntaxKind.MinusMinusToken:
                        opCode = Ops.SUB;
                        break;
                }

                this.emitNumericConst('1');

                // Special case to remember source of 'field'
                this.resolver.prefixPostfix = true;
                this.processExpression(node.operand);
                this.resolver.prefixPostfix = false;

                // TODO: this code can be improved by attaching Ops codes to ResolvedInfo instead of guessing where
                // the beginning of the command
                const operandPosition = this.functionContext.code.length - 1;

                // +/- 1
                const operandInfo = this.functionContext.stack.pop().optimize();
                const value1Info = this.functionContext.stack.pop().optimize();
                const resultPlusOrMinusInfo = this.functionContext.useRegisterAndPush();

                this.functionContext.code.push([
                    opCode,
                    resultPlusOrMinusInfo.getRegister(),
                    operandInfo.getRegister(),
                    value1Info.getRegisterOrIndex()]);

                // save
                const operationResultInfo = this.functionContext.stack.pop();

                const readOpCode = this.functionContext.code.codeAt(operandPosition);
                if (readOpCode && readOpCode[0] === Ops.GETTABUP) {
                    this.functionContext.code.push([
                        Ops.SETTABUP,
                        readOpCode[2],
                        readOpCode[3],
                        resultPlusOrMinusInfo.getRegister()
                    ]);
                } else if (readOpCode && readOpCode[0] === Ops.GETTABLE) {
                    this.functionContext.code.push([
                        Ops.SETTABLE,
                        readOpCode[2],
                        readOpCode[3],
                        resultPlusOrMinusInfo.getRegister()
                    ]);
                } else if (readOpCode && readOpCode[0] === Ops.GETUPVAL) {
                    this.functionContext.code.push([
                        Ops.SETUPVAL,
                        readOpCode[2],
                        resultPlusOrMinusInfo.getRegister()
                    ]);
                } else if (operandInfo.kind === ResolvedKind.Register) {
                    this.functionContext.code.push([
                        Ops.MOVE,
                        (operandInfo.originalInfo || operandInfo).getRegister(),
                        resultPlusOrMinusInfo.getRegister()]);
                }

                // clone value
                if (!this.isValueNotRequired(node.parent)) {
                    this.functionContext.stack.push(operationResultInfo);
                }

                break;
            case ts.SyntaxKind.PlusToken:
                this.processExpression(node.operand);
                break;
            default:
                throw new Error('Not Implemented');
        }
    }

    private processPostfixUnaryExpression(node: ts.PostfixUnaryExpression): void {
        let opCode;
        switch (node.operator) {
            case ts.SyntaxKind.PlusPlusToken:
            case ts.SyntaxKind.MinusMinusToken:
                switch (node.operator) {
                    case ts.SyntaxKind.PlusPlusToken:
                        opCode = Ops.ADD;
                        break;
                    case ts.SyntaxKind.MinusMinusToken:
                        opCode = Ops.SUB;
                        break;
                }

                // Special case to remember source of 'field'
                this.resolver.prefixPostfix = true;
                this.processExpression(node.operand);
                this.resolver.prefixPostfix = false;

                // TODO: this code can be improved by ataching Ops codes to
                // ResolvedInfo instead of guessing where the beginning of the command
                const operandPosition = this.functionContext.code.length - 1;

                const resurveSpace = this.functionContext.useRegisterAndPush();
                this.emitNumericConst('1');
                const value1Info = this.functionContext.stack.pop().optimize();

                // clone
                const operandInfo = this.functionContext.stack.peekSkip(-1);

                // +/- 1
                const resultPlusOrMinuesInfo = this.functionContext.useRegisterAndPush();
                this.functionContext.code.push([
                    opCode,
                    resultPlusOrMinuesInfo.getRegister(),
                    operandInfo.getRegister(),
                    value1Info.getRegisterOrIndex()]);

                // consumed operand
                this.functionContext.stack.pop();
                // consume reserved space
                this.functionContext.stack.pop();

                // save
                const readOpCode = this.functionContext.code.codeAt(operandPosition);
                if (readOpCode && readOpCode[0] === Ops.GETTABUP) {
                    this.functionContext.code.push([
                        Ops.SETTABUP,
                        readOpCode[2],
                        readOpCode[3],
                        resultPlusOrMinuesInfo.getRegister()
                    ]);

                    if (operandInfo.hasPopChain) {
                        this.functionContext.stack.pop();
                        const resultNewPositionInfo = this.functionContext.useRegisterAndPush();
                        this.functionContext.code.push([
                            Ops.MOVE,
                            resultNewPositionInfo.getRegister(),
                            resultPlusOrMinuesInfo.getRegister()]);
                    }

                } else if (readOpCode && readOpCode[0] === Ops.GETTABLE) {
                    this.functionContext.code.push([
                        Ops.SETTABLE,
                        readOpCode[2],
                        readOpCode[3],
                        resultPlusOrMinuesInfo.getRegister()
                    ]);
                } else if (readOpCode && readOpCode[0] === Ops.MOVE) {
                    this.functionContext.code.push([
                        Ops.MOVE,
                        readOpCode[2],
                        resultPlusOrMinuesInfo.getRegister()]);
                }

                if (this.isValueNotRequired(node.parent)) {
                    this.functionContext.stack.pop();
                } else if (operandInfo.hasPopChain) {
                    const resultNewPositionInfo = this.functionContext.stack.peekSkip(-1);
                    const clonedValue = this.functionContext.stack.pop();
                    // 1 register is not free
                    this.functionContext.useRegister();
                    this.functionContext.stack.push(resultNewPositionInfo);
                    this.functionContext.code.push([
                        Ops.MOVE,
                        resultNewPositionInfo.getRegister(),
                        clonedValue.getRegister()]);
                }

                break;
        }
    }

    private processConditionalExpression(node: ts.ConditionalExpression): void {
        this.processExpression(node.condition);

        const equalsTo = 0;
        const conditionInfo = this.functionContext.stack.pop().optimize();
        const resultInfo = this.functionContext.useRegisterAndPush();

        const testSetOp = [Ops.TEST, conditionInfo.getRegisterOrIndex(), equalsTo];
        this.functionContext.code.push(testSetOp);

        const jmpOp = [Ops.JMP, 0, 1];
        this.functionContext.code.push(jmpOp);

        const beforeBlock = this.functionContext.code.length;

        this.processExpression(node.whenTrue);
        const whenTrueInfo = this.functionContext.stack.pop().optimize();

        if (whenTrueInfo.getRegisterOrIndex() < 0) {
            this.functionContext.code.push([
                Ops.LOADK,
                resultInfo.getRegister(),
                whenTrueInfo.getRegisterOrIndex(),
                0]);
        } else {
            this.functionContext.code.push([
                Ops.MOVE,
                resultInfo.getRegister(),
                whenTrueInfo.getRegister(),
                0]);
        }

        const jmpElseOp = [Ops.JMP, 0, 1];
        this.functionContext.code.push(jmpElseOp);

        const elseBlock = this.functionContext.code.length;

        jmpOp[2] = this.functionContext.code.length - beforeBlock;

        this.processExpression(node.whenFalse);
        const whenFalseInfo = this.functionContext.stack.pop().optimize();

        if (whenFalseInfo.getRegisterOrIndex() < 0) {
            this.functionContext.code.push([
                Ops.LOADK,
                resultInfo.getRegister(),
                whenFalseInfo.getRegisterOrIndex(),
                0]);
        } else {
            this.functionContext.code.push([
                Ops.MOVE,
                resultInfo.getRegister(),
                whenFalseInfo.getRegister(),
                0]);
        }

        jmpElseOp[2] = this.functionContext.code.length - elseBlock;
    }

    private processBinaryExpression(node: ts.BinaryExpression): void {
        // perform '='
        switch (node.operatorToken.kind) {
            case ts.SyntaxKind.EqualsToken:

                // ... = <right>
                this.processExpression(node.right);

                // <left> = ...
                this.processExpression(node.left);

                this.emitAssignOperation(node);

                break;

            case ts.SyntaxKind.PlusToken:
            case ts.SyntaxKind.MinusToken:
            case ts.SyntaxKind.AsteriskToken:
            case ts.SyntaxKind.AsteriskAsteriskToken:
            case ts.SyntaxKind.PercentToken:
            case ts.SyntaxKind.CaretToken:
            case ts.SyntaxKind.SlashToken:
            case ts.SyntaxKind.AmpersandToken:
            case ts.SyntaxKind.BarToken:
            case ts.SyntaxKind.CaretToken:
            case ts.SyntaxKind.LessThanLessThanToken:
            case ts.SyntaxKind.GreaterThanGreaterThanToken:
            case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:

            case ts.SyntaxKind.PlusEqualsToken:
            case ts.SyntaxKind.MinusEqualsToken:
            case ts.SyntaxKind.AsteriskEqualsToken:
            case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
            case ts.SyntaxKind.PercentEqualsToken:
            case ts.SyntaxKind.CaretEqualsToken:
            case ts.SyntaxKind.SlashEqualsToken:
            case ts.SyntaxKind.AmpersandEqualsToken:
            case ts.SyntaxKind.BarEqualsToken:
            case ts.SyntaxKind.CaretEqualsToken:
            case ts.SyntaxKind.LessThanLessThanEqualsToken:
            case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
            case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:

                let leftOpNode;
                let rightOpNode;

                let operationCode = this.opsMap[node.operatorToken.kind];
                if ((node.operatorToken.kind === ts.SyntaxKind.PlusToken
                    || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
                    && (this.typeInfo.isTypeOfNode(node, 'string')
                        || this.typeInfo.isTypeOfNode(node.left, 'string')
                        || this.typeInfo.isTypeOfNode(node.right, 'right'))) {
                    operationCode = Ops.CONCAT;
                }

                // operation
                switch (node.operatorToken.kind) {
                    case ts.SyntaxKind.AmpersandToken:
                    case ts.SyntaxKind.BarToken:
                    case ts.SyntaxKind.CaretToken:

                    case ts.SyntaxKind.AmpersandEqualsToken:
                    case ts.SyntaxKind.BarEqualsToken:
                    case ts.SyntaxKind.CaretEqualsToken:

                        // FLOAT -> INT
                        const op1 = ts.createCall(ts.createPropertyAccess(ts.createIdentifier('math'), 'floor'), undefined, [node.left]);
                        op1.parent = node;
                        const op2 = ts.createCall(ts.createPropertyAccess(ts.createIdentifier('math'), 'floor'), undefined, [node.right]);
                        op2.parent = node;

                        // <left> + ...
                        this.processExpression(op1);

                        // ... + <right>
                        this.processExpression(op2);

                        break;
                    case ts.SyntaxKind.PlusToken:
                    case ts.SyntaxKind.MinusToken:
                    case ts.SyntaxKind.AsteriskToken:
                    case ts.SyntaxKind.SlashToken:

                        const op1_notnull = ts.createBinary(node.left, ts.SyntaxKind.BarBarToken, ts.createNumericLiteral('0'));
                        op1_notnull.parent = node;
                        const op2_notnull = ts.createBinary(node.right, ts.SyntaxKind.BarBarToken, ts.createNumericLiteral('0'));
                        op2_notnull.parent = node;

                        // <left> + ...
                        this.processExpression(op1_notnull);

                        // ... + <right>
                        this.processExpression(op2_notnull);

                        break;
                    default:
                        // <left> + ...
                        this.processExpression(node.left);

                        // ... + <right>
                        this.processExpression(node.right);
                        break;
                }


                if (operationCode === Ops.CONCAT) {
                    rightOpNode = this.functionContext.stack.pop();
                    leftOpNode = this.functionContext.stack.pop();
                } else {
                    rightOpNode = this.functionContext.stack.pop().optimize();
                    leftOpNode = this.functionContext.stack.pop().optimize();
                }

                const resultInfo = this.functionContext.useRegisterAndPush();

                this.functionContext.code.push([
                    operationCode,
                    resultInfo.getRegister(),
                    leftOpNode.getRegisterOrIndex(),
                    rightOpNode.getRegisterOrIndex()]);

                // we need to store result at the end of operation
                switch (node.operatorToken.kind) {
                    case ts.SyntaxKind.PlusEqualsToken:
                    case ts.SyntaxKind.MinusEqualsToken:
                    case ts.SyntaxKind.AsteriskEqualsToken:
                    case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
                    case ts.SyntaxKind.PercentEqualsToken:
                    case ts.SyntaxKind.CaretEqualsToken:
                    case ts.SyntaxKind.SlashEqualsToken:
                    case ts.SyntaxKind.AmpersandEqualsToken:
                    case ts.SyntaxKind.BarEqualsToken:
                    case ts.SyntaxKind.CaretEqualsToken:
                    case ts.SyntaxKind.LessThanLessThanEqualsToken:
                    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
                    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:

                        // <left> = ...
                        this.processExpression(node.left);

                        this.emitAssignOperation(node);
                        break;
                }

                break;

            case ts.SyntaxKind.EqualsEqualsToken:
            case ts.SyntaxKind.EqualsEqualsEqualsToken:
            case ts.SyntaxKind.LessThanToken:
            case ts.SyntaxKind.LessThanEqualsToken:
            case ts.SyntaxKind.ExclamationEqualsToken:
            case ts.SyntaxKind.ExclamationEqualsEqualsToken:
            case ts.SyntaxKind.GreaterThanToken:
            case ts.SyntaxKind.GreaterThanEqualsToken:

                // ... = <right>
                this.processExpression(node.right);

                // <left> = ...
                this.processExpression(node.left);

                const leftOpNode2 = this.functionContext.stack.pop().optimize();
                const rightOpNode2 = this.functionContext.stack.pop().optimize();
                const resultInfo2 = this.functionContext.useRegisterAndPush();

                let equalsTo = 1;
                switch (node.operatorToken.kind) {
                    case ts.SyntaxKind.ExclamationEqualsToken:
                    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
                    case ts.SyntaxKind.GreaterThanToken:
                    case ts.SyntaxKind.GreaterThanEqualsToken:
                        equalsTo = 0;
                        break;
                }

                this.functionContext.code.push([
                    this.opsMap[node.operatorToken.kind],
                    equalsTo,
                    leftOpNode2.getRegisterOrIndex(),
                    rightOpNode2.getRegisterOrIndex()]);

                // in case of logical ops finish it
                const trueValue = 1;
                const falseValue = 0;

                this.functionContext.code.push([
                    Ops.JMP,
                    0,
                    1]);

                this.functionContext.code.push([
                    Ops.LOADBOOL,
                    resultInfo2.getRegister(),
                    falseValue,
                    1]);

                this.functionContext.code.push([
                    Ops.LOADBOOL,
                    resultInfo2.getRegister(),
                    trueValue,
                    0]);

                break;

            case ts.SyntaxKind.AmpersandAmpersandToken:
            case ts.SyntaxKind.BarBarToken:

                // <left> = ...
                this.processExpression(node.left);

                // fix when 0 is true in LUA
                // TODO: move it into "Preprocess logic"
                if (!(<any>node).__fix_not_required) {
                    if (this.typeInfo.isTypesOfNode(node.left, ['number', 'any'])) {
                        const op1 = this.functionContext.stack.peek();

                        this.functionContext.newLocalScope(node);

                        this.functionContext.createLocal('<op1>', op1);
                        const localOp1Ident = ts.createIdentifier('<op1>');

                        let condition;
                        switch (node.operatorToken.kind) {
                            case ts.SyntaxKind.AmpersandAmpersandToken:
                                condition = ts.createBinary(
                                    ts.createPrefix(ts.SyntaxKind.ExclamationToken, localOp1Ident),
                                    ts.SyntaxKind.BarBarToken,
                                    ts.createBinary(localOp1Ident, ts.SyntaxKind.EqualsEqualsToken, ts.createNumericLiteral('0')));
                                break;
                            case ts.SyntaxKind.BarBarToken:
                                condition = ts.createBinary(
                                    localOp1Ident,
                                    ts.SyntaxKind.AmpersandAmpersandToken,
                                    ts.createBinary(localOp1Ident, ts.SyntaxKind.ExclamationEqualsToken, ts.createNumericLiteral('0')));
                                break;
                        }

                        (<any>condition).__fix_not_required = true;

                        const condExpression = ts.createConditional(condition, localOp1Ident, node.right);
                        condExpression.parent = node;
                        this.processExpression(condExpression);

                        this.functionContext.restoreLocalScope();

                        const result = this.functionContext.stack.pop();
                        this.functionContext.code.push([
                            Ops.MOVE,
                            op1.getRegister(),
                            result.getRegister(),
                            0]);

                        return;
                    }
                }

                const leftOpNode3 = this.functionContext.stack.pop().optimize();

                let equalsTo2 = 0;
                switch (node.operatorToken.kind) {
                    case ts.SyntaxKind.BarBarToken:
                        equalsTo2 = 1;
                        break;
                }

                const testSetOp = [
                    Ops.TESTSET,
                    undefined,
                    leftOpNode3.getRegisterOrIndex(),
                    equalsTo2];
                this.functionContext.code.push(testSetOp);

                const jmpOp = [
                    Ops.JMP,
                    0,
                    1];
                this.functionContext.code.push(jmpOp);
                const beforeBlock = this.functionContext.code.length;

                // ... = <right>
                this.processExpression(node.right);

                const rightOpNode3 = this.functionContext.stack.pop().optimize();
                const resultInfo3 = this.functionContext.useRegisterAndPush();
                testSetOp[1] = resultInfo3.getRegister();

                if (rightOpNode3.getRegisterOrIndex() < 0) {
                    this.functionContext.code.push([
                        Ops.LOADK,
                        resultInfo3.getRegister(),
                        rightOpNode3.getRegisterOrIndex(),
                        0]);
                } else {
                    this.functionContext.code.push([
                        Ops.MOVE,
                        resultInfo3.getRegister(),
                        rightOpNode3.getRegister(),
                        0]);
                }

                jmpOp[2] = this.functionContext.code.length - beforeBlock;

                break;

            case ts.SyntaxKind.InKeyword:

                const inExpression = ts.createBinary(
                    ts.createElementAccess(node.right, node.left),
                    ts.SyntaxKind.ExclamationEqualsEqualsToken,
                    ts.createNull());
                inExpression.parent = node.parent;
                this.processExpression(inExpression);

                break;

            case ts.SyntaxKind.CommaToken:

                this.processExpression(node.left);
                this.processExpression(node.right);

                break;

            case ts.SyntaxKind.InstanceOfKeyword:
                // TODO: temporary solution, finish it
                /*
                const instanceOfExpression = ts.createBinary(
                    ts.createTypeOf(node.right),
                    ts.SyntaxKind.EqualsEqualsToken,
                    node.left);
                instanceOfExpression.parent = node.parent;
                this.processExpression(instanceOfExpression);
                */

                const instanceOfCall = ts.createCall(ts.createIdentifier('__instanceof'), undefined, [node.left, node.right]);
                instanceOfCall.parent = node.parent;
                this.processExpression(instanceOfCall);

                break;

            default: throw new Error('Not Implemented');
        }
    }

    private emitAssignOperation(node: ts.Node) {
        const leftOperandInfo = this.functionContext.stack.pop();
        const rightOperandInfo = this.functionContext.stack.pop();
        const readOpCode = this.functionContext.code.latest;

        if (leftOperandInfo.kind === ResolvedKind.Register) {
            if (readOpCode[0] === Ops.GETTABUP) {
                if (node.parent && node.parent.kind !== ts.SyntaxKind.ExpressionStatement) {
                    // we need to store register in stack to reuse it in next expression
                    this.functionContext.stack.push(rightOperandInfo);
                }
                // left of = is method reference
                const getTabUpOpArray = this.functionContext.code.pop();
                rightOperandInfo.optimize();
                this.functionContext.code.push([
                    Ops.SETTABUP,
                    getTabUpOpArray[2],
                    getTabUpOpArray[3],
                    rightOperandInfo.getRegisterOrIndex()
                ]);
            } else if (readOpCode[0] === Ops.GETTABLE) {
                if (node.parent && node.parent.kind !== ts.SyntaxKind.ExpressionStatement) {
                    // we need to store register in stack to reuse it in next expression
                    this.functionContext.stack.push(rightOperandInfo);
                }
                // left of = is method reference
                const getTableOpArray = this.functionContext.code.pop();
                rightOperandInfo.optimize();
                this.functionContext.code.push([
                    Ops.SETTABLE,
                    getTableOpArray[2],
                    getTableOpArray[3],
                    rightOperandInfo.getRegisterOrIndex()
                ]);
            } else if (readOpCode[0] === Ops.GETUPVAL) {
                if (node.parent && node.parent.kind !== ts.SyntaxKind.ExpressionStatement) {
                    // we need to store register in stack to reuse it in next expression
                    this.functionContext.stack.push(rightOperandInfo);
                }
                const getUpValueArray = this.functionContext.code.pop();
                // Optimization can't be used here
                this.functionContext.code.push([
                    Ops.SETUPVAL,
                    rightOperandInfo.getRegisterOrIndex(),
                    getUpValueArray[2]
                ]);
            } else if (readOpCode[0] === Ops.MOVE) {
                if (node.parent && node.parent.kind !== ts.SyntaxKind.ExpressionStatement) {
                    // we need to store register in stack to reuse it in next expression
                    this.functionContext.stack.push(leftOperandInfo);
                }
                // if we put local var value we need to remove it
                const readMoveOpArray = this.functionContext.code.pop();
                leftOperandInfo.register = readMoveOpArray[2];
                this.functionContext.code.push([Ops.MOVE, leftOperandInfo.getRegister(), rightOperandInfo.getRegister()]);
            } else {
                if (node.parent && node.parent.kind !== ts.SyntaxKind.ExpressionStatement) {
                    // we need to store register in stack to reuse it in next expression
                    this.functionContext.stack.push(leftOperandInfo);
                }
                this.functionContext.code.push([Ops.MOVE, leftOperandInfo.getRegister(), rightOperandInfo.getRegister()]);
            }
        } else if (leftOperandInfo.kind === ResolvedKind.Upvalue) {
            this.functionContext.code.push([
                Ops.SETUPVAL,
                rightOperandInfo.getRegister(),
                leftOperandInfo.getRegisterOrIndex()
            ]);
        } else {
            throw new Error('Not Implemented');
        }
    }

    private processDeleteExpression(node: ts.DeleteExpression): void {
        const assignNull = ts.createAssignment(node.expression, ts.createNull());
        assignNull.parent = node;
        this.processExpression(assignNull);
    }

    private processNewExpression(node: ts.NewExpression, extraCodeBeforeConstructor?: (arrayRef: ResolvedInfo) => void): void {

        /*
        // special cases: new Array and new Object
        if (!this.jsLib) {
            if (node.expression.kind === ts.SyntaxKind.Identifier && (!node.arguments || node.arguments.length === 0)) {
                const name = node.expression.getText();
                if (name === 'Object') {
                    return this.processObjectLiteralExpression(ts.createObjectLiteral());
                }

                if (name === 'Array') {
                    return this.processArrayLiteralExpression(ts.createArrayLiteral());
                }

                if (name === 'String') {
                    return this.processStringLiteral(ts.createStringLiteral(''));
                }
            }
        }
        */

        this.processExpression(
            ts.createObjectLiteral([
                ts.createPropertyAssignment('__proto', node.expression),
                ts.createPropertyAssignment('__index', node.expression)
            ]));
        const resultInfo = this.functionContext.stack.peek();

        this.processExpression(ts.createIdentifier('setmetatable'));
        const setmetatableInfo = this.functionContext.stack.peek();

        // call setmetatable(obj, obj)
        const param1Info = this.functionContext.useRegisterAndPush();
        this.functionContext.code.push([
            Ops.MOVE, param1Info.getRegister(), resultInfo.getRegisterOrIndex()
        ]);

        const param2Info = this.functionContext.useRegisterAndPush();
        this.functionContext.code.push([
            Ops.MOVE, param2Info.getRegister(), resultInfo.getRegisterOrIndex()
        ]);

        // call setmetatable
        this.functionContext.code.push([
            Ops.CALL, setmetatableInfo.getRegister(), 3, 1
        ]);

        // call cleanup
        this.functionContext.stack.pop();
        this.functionContext.stack.pop();
        this.functionContext.stack.pop();

        if (extraCodeBeforeConstructor) {
            extraCodeBeforeConstructor(resultInfo);
        }

        // call constructor
        const methodInfo = this.functionContext.useRegisterAndPush();
        let constructorInfo = this.resolver.returnConst('constructor', this.functionContext);

        const reserveSpace = this.functionContext.useRegisterAndPush();
        constructorInfo = this.preprocessConstAndUpvalues(constructorInfo);

        this.functionContext.code.push([
            Ops.SELF,
            methodInfo.getRegister(),
            resultInfo.getRegister(),
            constructorInfo.getRegisterOrIndex()]);

        this.stackCleanup(constructorInfo);
        // cleanup of reserve
        this.functionContext.stack.pop();

        // to reserve 'this' register
        this.functionContext.useRegisterAndPush();

        // in case of empty constructor we need to skip call
        this.functionContext.code.push([Ops.TEST, methodInfo.getRegister(), 0]);
        const jmpOp = [Ops.JMP, 0, 0];
        this.functionContext.code.push(jmpOp);
        const beforeBlock = this.functionContext.code.length;

        this.emitCallOfLoadedMethod(
            <ts.CallExpression><any>{ parent: node, 'arguments': node.arguments || [] },
            resultInfo,
            true);

        jmpOp[2] = this.functionContext.code.length - beforeBlock;
    }

    private processCallExpression(node: ts.CallExpression): void {

        this.resolver.pushAndSetMethodCallInfo();

        // special cases to cast to string or number
        let processed = false;
        if (node.expression.kind === ts.SyntaxKind.Identifier && node.arguments.length === 1) {
            const name = node.expression.kind === ts.SyntaxKind.Identifier ? (<ts.Identifier>node.expression).text : '';
            if (name === 'String' || name === 'Number') {
                this.processExpression(ts.createIdentifier('to' + name.toLowerCase()));
                processed = true;
            }
        }

        // default case
        if (!processed) {
            this.processExpression(node.expression);
        }

        const selfOpCodeResolveInfoForThis = this.resolver.thisMethodCall;

        this.resolver.clearMethodCallInfo();

        this.emitCallOfLoadedMethod(node, selfOpCodeResolveInfoForThis);

        this.resolver.popMethodCallInfo();
    }

    private isValueNotRequired(parent: ts.Node): boolean {
        if (!parent) {
            return true;
        }

        return parent.kind === ts.SyntaxKind.ExpressionStatement
            || parent.kind === ts.SyntaxKind.VoidExpression
            || parent.kind === ts.SyntaxKind.ClassDeclaration
            || parent.kind === ts.SyntaxKind.ImportDeclaration;
    }

    private emitCallOfLoadedMethod(node: ts.CallExpression, _thisForNew?: ResolvedInfo, constructorCall?: boolean) {
        let wrapCallMethod = false;
        node.arguments.forEach(a => {
            // pop method arguments
            this.processExpression(a);
            if ((<any>a).__self_call_required) {
                wrapCallMethod = true;
            }
        });
        node.arguments.forEach(a => {
            this.functionContext.stack.pop();
        });
        if (_thisForNew) {
            this.functionContext.stack.pop();
        }

        const methodResolvedInfo = this.functionContext.stack.pop();
        // TODO: temporary solution: if method called in Statement then it is not returning value
        const parent = node.parent;
        const noReturnCall = constructorCall || this.isValueNotRequired(parent);
        let isLastMethodArgumentCallOrSpreadElementOrLastOfArrayLiteral = parent && parent.kind === ts.SyntaxKind.SpreadElement;
        if (!isLastMethodArgumentCallOrSpreadElementOrLastOfArrayLiteral
            && parent
            && (parent.kind === ts.SyntaxKind.CallExpression
                || parent.kind === ts.SyntaxKind.NewExpression)) {
            // check if it last call method argument
            const callMethod = <ts.CallExpression>parent;
            if (callMethod.arguments.length > 0 && callMethod.arguments[callMethod.arguments.length - 1] === node) {
                isLastMethodArgumentCallOrSpreadElementOrLastOfArrayLiteral = true;
            }
        }

        if (!isLastMethodArgumentCallOrSpreadElementOrLastOfArrayLiteral
            && parent
            && (parent.kind === ts.SyntaxKind.ArrayLiteralExpression)) {
            // check if it last element
            const callMethod = <ts.ArrayLiteralExpression>parent;
            if (callMethod.elements.length > 0 && callMethod.elements[callMethod.elements.length - 1] === node) {
                isLastMethodArgumentCallOrSpreadElementOrLastOfArrayLiteral = true;
            }
        }

        if (!isLastMethodArgumentCallOrSpreadElementOrLastOfArrayLiteral
            && parent
            && parent.kind === ts.SyntaxKind.ReturnStatement) {
            // support variable return
            const ret = this.GetVariableReturn();
            if (ret) {
                isLastMethodArgumentCallOrSpreadElementOrLastOfArrayLiteral = true;
            }
        }

        const returnCount = noReturnCall ? 1 : isLastMethodArgumentCallOrSpreadElementOrLastOfArrayLiteral ? 0 : 2;
        if (returnCount !== 1) {
            this.functionContext.useRegisterAndPush();
        }

        // parameters number
        let parametersNumber = node.arguments.length + 1 + (_thisForNew || wrapCallMethod ? 1 : 0);
        if (node.arguments.some(a => a.kind === ts.SyntaxKind.SpreadElement)) {
            parametersNumber = 0;
        } else if (node.arguments.length === 1 && node.arguments.some(a => a.kind === ts.SyntaxKind.CallExpression)) {
            // there is only 1 parameter and it is method call
            parametersNumber = 0;
        }

        this.functionContext.code.push(
            [
                Ops.CALL,
                methodResolvedInfo.getRegister(),
                parametersNumber,
                returnCount
            ]);
    }

    private processThisExpression(node: ts.ThisExpression): void {
        if (this.functionContext.thisInUpvalue) {
            const resolvedInfo = this.resolver.returnThisUpvalue(this.functionContext);

            const resultInfo = this.functionContext.useRegisterAndPush();
            resultInfo.originalInfo = resolvedInfo;
            this.functionContext.code.push([Ops.GETUPVAL, resultInfo.getRegister(), resolvedInfo.getRegisterOrIndex()]);
            return;
        }

        if (this.functionContext.isStatic) {
            this.processExpression(this.resolver.thisClassName);
            return;
        }

        const resultThisInfo = this.functionContext.useRegisterAndPush();
        resultThisInfo.originalInfo = this.resolver.returnThis(this.functionContext);
        this.functionContext.code.push([Ops.MOVE, resultThisInfo.getRegister(), resultThisInfo.originalInfo.getRegisterOrIndex()]);
    }

    private processSuperExpression(node: ts.SuperExpression): void {
        if (node.parent.kind === ts.SyntaxKind.CallExpression) {
            // this is construction call
            const constructorCall = ts.createPropertyAccess(this.resolver.superClass, ts.createIdentifier('constructor'));
            constructorCall.parent = node.parent;
            this.processExpression(constructorCall);
        } else {
            this.processExpression(this.resolver.superClass);
        }
    }

    private processVoidExpression(node: ts.VoidExpression): void {
        // call expression
        this.processExpression(node.expression);
        this.functionContext.stack.pop();

        // convert it into null
        this.processExpression(ts.createIdentifier('undefined'));
    }

    private processNonNullExpression(node: ts.NonNullExpression): void {
        this.processExpression(node.expression);
    }

    private processAsExpression(node: ts.AsExpression): void {
        this.processExpression(node.expression);
    }

    private processSpreadElement(node: ts.SpreadElement): void {
        const propertyAccessExpression = ts.createPropertyAccess(ts.createIdentifier('table'), ts.createIdentifier('unpack'));
        const spreadCall = ts.createCall(
            propertyAccessExpression,
            undefined,
            [node.expression]);
        spreadCall.parent = node;
        this.processExpression(spreadCall);
    }

    private processAwaitExpression(node: ts.AwaitExpression): void {
        const newFunctionBlock = ts.createBlock([ts.createReturn(node.expression)]);
        const newFunction = ts.createFunctionExpression([], undefined, undefined, undefined, [], undefined, newFunctionBlock);
        const createCall = ts.createCall(ts.createPropertyAccess(ts.createIdentifier('coroutine'), 'create'), undefined, [
            newFunction
        ]);
        // create call: coroutine.resume(coroutine.create(6))
        const callResume = ts.createCall(ts.createPropertyAccess(ts.createIdentifier('coroutine'), 'resume'), undefined, [
            createCall
        ]);

        const callTablePack = ts.createCall(ts.createPropertyAccess(ts.createIdentifier('table'), 'pack'), undefined, [
            callResume
        ]);

        const getSecondValue = ts.createElementAccess(callTablePack, 2);

        createCall.parent = callResume;
        callResume.parent = callTablePack;
        callTablePack.parent = getSecondValue;
        getSecondValue.parent = node.parent;

        this.bind(ts.createExpressionStatement(getSecondValue));

        (<any>callResume).__origin = node;

        // reset parent after bind
        getSecondValue.parent = node.parent;

        this.processExpression(getSecondValue);
    }

    private preprocessConstAndUpvalues(resolvedInfo: ResolvedInfo): ResolvedInfo {
        if (this.allowConstBigger255 && !this.splitConstFromOpCode) {
            return resolvedInfo;
        }

        const can1 = resolvedInfo.canUseIndex();
        if (can1 && !(this.splitConstFromOpCode && resolvedInfo.kind === ResolvedKind.Const)) {
            return resolvedInfo;
        }

        if (resolvedInfo.kind === ResolvedKind.Const) {
            const resultInfo = this.functionContext.useRegisterAndPush();
            resultInfo.originalInfo = resolvedInfo.originalInfo;
            resultInfo.popRequired = true;
            this.functionContext.code.push([Ops.LOADK, resultInfo.getRegister(), resolvedInfo.getRegisterOrIndex()]);
            return resultInfo;
        }

        throw new Error('Not Implemented');
    }

    private stackCleanup(resolvedInfo: ResolvedInfo) {
        if (resolvedInfo.popRequired) {
            this.functionContext.stack.pop();
        }
    }

    private processIndentifier(node: ts.Identifier): void {
        const resolvedInfo = this.resolver.resolver(<ts.Identifier>node, this.functionContext);
        if (resolvedInfo.kind === ResolvedKind.Register) {
            const resultInfo = this.functionContext.useRegisterAndPush();
            resultInfo.originalInfo = resolvedInfo;
            this.functionContext.code.push([Ops.MOVE, resultInfo.getRegister(), resolvedInfo.getRegisterOrIndex()]);
            return;
        }

        if (resolvedInfo.kind === ResolvedKind.Upvalue) {
            const resultInfo = this.functionContext.useRegisterAndPush();
            resultInfo.originalInfo = resolvedInfo;
            this.functionContext.code.push([Ops.GETUPVAL, resultInfo.getRegister(), resolvedInfo.getRegisterOrIndex()]);
            return;
        }

        if (resolvedInfo.kind === ResolvedKind.Const) {
            if (resolvedInfo.value === null) {
                const resultInfoNull = this.functionContext.useRegisterAndPush();
                resultInfoNull.originalInfo = resolvedInfo;
                this.functionContext.code.push([Ops.LOADNIL, resultInfoNull.getRegister(), 1]);
                return;
            }

            const resultInfo = this.functionContext.useRegisterAndPush();
            resultInfo.originalInfo = resolvedInfo;
            this.functionContext.code.push([Ops.LOADK, resultInfo.getRegister(), resolvedInfo.getRegisterOrIndex()]);
            return;
        }

        if (resolvedInfo.kind === ResolvedKind.LoadGlobalMember) {
            let objectIdentifierInfo = resolvedInfo.objectInfo;
            let memberIdentifierInfo = resolvedInfo.memberInfo;
            memberIdentifierInfo.isTypeReference = resolvedInfo.isTypeReference;
            memberIdentifierInfo.declarationInfo = resolvedInfo.declarationInfo;

            const resultInfo = this.functionContext.useRegisterAndPush();
            resultInfo.originalInfo = memberIdentifierInfo;

            objectIdentifierInfo = this.preprocessConstAndUpvalues(objectIdentifierInfo);
            memberIdentifierInfo = this.preprocessConstAndUpvalues(memberIdentifierInfo);

            this.functionContext.code.push(
                [Ops.GETTABUP,
                resultInfo.getRegister(),
                objectIdentifierInfo.getRegisterOrIndex(),
                memberIdentifierInfo.getRegisterOrIndex()]);

            this.stackCleanup(memberIdentifierInfo);
            this.stackCleanup(objectIdentifierInfo);

            return;
        }

        throw new Error('Not Implemeneted');
    }

    private popDependancy(target: ResolvedInfo, dependancy: ResolvedInfo) {
        dependancy.chainPop = target;
        target.hasPopChain = true;
    }

    private processPropertyAccessExpression(node: ts.PropertyAccessExpression): void {
        this.processExpression(node.expression);

        // HACK: special case to support #len
        if ((<any>node.name).__len) {
            const expressionInfo = this.functionContext.stack.pop().optimize();
            const lenResultInfo = this.functionContext.useRegisterAndPush();
            this.functionContext.code.push(
                [Ops.LEN,
                lenResultInfo.getRegister(),
                expressionInfo.getRegisterOrIndex()]);
            return;
        }

        this.resolver.Scope.push(this.functionContext.stack.peek());
        this.processExpression(node.name);
        this.resolver.Scope.pop();

        let prefixPostfix = this.resolver.prefixPostfix;
        // perform load
        // we can call collapseConst becasee member is name all the time which means it is const value
        let memberIdentifierInfo = this.functionContext.stack.pop().collapseConst().optimize();
        let objectIdentifierInfo = this.resolver.prefixPostfix
            ? this.functionContext.stack.peek()
            : this.functionContext.stack.pop().optimize();

        let opCode = Ops.GETTABLE;

        const objectOriginalInfo = objectIdentifierInfo.originalInfo;
        const upvalueOrConst = objectOriginalInfo
            && (objectOriginalInfo.kind === ResolvedKind.Upvalue && objectOriginalInfo.identifierName === '_ENV'
                                /*|| objectOriginalInfo.kind === ResolvedKind.Const*/);
        const methodDeclInfo = this.resolver.methodCall
            && memberIdentifierInfo.originalInfo
            && memberIdentifierInfo.originalInfo.declarationInfo;

        const methodDeclInfoModifiers = methodDeclInfo
            && methodDeclInfo.modifiers;

        const isMemberStatic = methodDeclInfoModifiers
            && methodDeclInfoModifiers.some(m => m.kind === ts.SyntaxKind.StaticKeyword);

        // this.<...>(this support)
        if (this.resolver.methodCall
            && objectIdentifierInfo.kind === ResolvedKind.Register
            && !(objectIdentifierInfo.originalInfo && objectIdentifierInfo.originalInfo.isTypeReference)
            && !upvalueOrConst
            && node.parent
            && node.parent.kind === ts.SyntaxKind.CallExpression) {
            opCode = Ops.SELF;
        }

        // support __wrapper calls
        const wrapMethodCall = (<any>node).__self_call_required === true;
        if (wrapMethodCall) {
            opCode = Ops.SELF;
        }

        if ((<any>node).__self_call_required === false) {
            // suppress self call
            opCode = Ops.GETTABLE;
        }

        const readOpCode = this.functionContext.code.latest;
        if (opCode === Ops.GETTABLE && readOpCode && readOpCode[0] === Ops.GETUPVAL) {
            if (prefixPostfix) {
                prefixPostfix = false;
                this.functionContext.stack.pop();
            }

            this.functionContext.code.pop();
            opCode = Ops.GETTABUP;
            objectIdentifierInfo.register = readOpCode[2];
        }

        const resultInfo = this.functionContext.useRegisterAndPush();
        if (prefixPostfix) {
            // to cause chain pop
            this.popDependancy(resultInfo, objectIdentifierInfo);
        }

        objectIdentifierInfo = this.preprocessConstAndUpvalues(objectIdentifierInfo);
        const reservedSpace = this.functionContext.useRegisterAndPush();
        memberIdentifierInfo = this.preprocessConstAndUpvalues(memberIdentifierInfo);
        resultInfo.originalInfo = memberIdentifierInfo.originalInfo;

        this.functionContext.code.push(
            [opCode,
                resultInfo.getRegister(),
                objectIdentifierInfo.getRegisterOrIndex(),
                memberIdentifierInfo.getRegisterOrIndex()]);

        if (opCode === Ops.SELF && !wrapMethodCall) {
            this.resolver.thisMethodCall = this.functionContext.useRegisterAndPush();
        }

        this.stackCleanup(memberIdentifierInfo);
        // clear up reserved
        this.functionContext.stack.pop();
        this.stackCleanup(objectIdentifierInfo);
    }

    private emitGetOrCreateObjectExpression(node: ts.Node, globalVariableName: string) {
        const prototypeIdentifier = ts.createIdentifier(globalVariableName);
        const getOrCreateObjectExpr = ts.createAssignment(
            prototypeIdentifier,
            ts.createBinary(prototypeIdentifier, ts.SyntaxKind.BarBarToken, ts.createObjectLiteral()));
        getOrCreateObjectExpr.parent = node.parent;
        this.processExpression(getOrCreateObjectExpr);
    }

    private emitHeader(): void {
        // writing header
        // LUA_SIGNATURE
        this.writer.writeArray([0x1b, 0x4c, 0x75, 0x61]);
        // LUAC_VERSION, LUAC_FORMAT
        this.writer.writeArray([0x53, 0x00]);
        // LUAC_DATA: data to catch conversion errors
        this.writer.writeArray([0x19, 0x93, 0x0d, 0x0a, 0x1a, 0x0a]);
        // sizeof(int), sizeof(size_t), sizeof(Instruction), sizeof(lua_Integer), sizeof(lua_Number)
        this.writer.writeArray([0x04, 0x08, 0x04, 0x08, 0x08]);
        // LUAC_INT
        this.writer.writeArray([0x78, 0x56, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0]);
        // LUAC_NUM
        this.writer.writeArray([0x0, 0x0, 0x0, 0x0, 0x0, 0x28, 0x77, 0x40]);
    }

    private emitFunction(functionContext: FunctionContext): void {
        this.emitFunctionHeader(functionContext);
        this.emitFunctionCode(functionContext);
        this.emitConstants(functionContext);
        this.emitUpvalues(functionContext);
        this.emitProtos(functionContext);
        this.emitDebug(functionContext);
    }

    private emitFunctionHeader(functionContext: FunctionContext): void {
        // write debug info, by default 0 (string)
        this.writer.writeString(functionContext.debug_location || null);

        // f->linedefined = 0, (int)
        this.writer.writeInt(functionContext.linedefined || 0);

        // f->lastlinedefined = 0, (int)
        this.writer.writeInt(functionContext.lastlinedefined || 0);

        // f->numparams (byte)
        this.writer.writeByte(functionContext.numparams || 0);

        // f->is_vararg (byte)
        this.writer.writeByte(functionContext.is_vararg ? 1 : 0);

        // f->maxstacksize
        this.writer.writeByte(functionContext.maxstacksize + 1);
    }

    private emitFunctionCode(functionContext: FunctionContext): void {
        this.writer.writeInt(functionContext.code.length);

        functionContext.code.forEach(c => {
            // create 4 bytes value
            const opCodeMode: OpMode = OpCodes[c[0]];
            const encoded = opCodeMode.encode(c);
            this.writer.writeInt(encoded);
        });
    }

    private emitConstants(functionContext: FunctionContext): void {
        this.writer.writeInt(functionContext.constants.length);

        functionContext.constants.forEach(c => {

            if (c !== null) {
                // create 4 bytes value
                switch (typeof c) {
                    case 'boolean':
                        this.writer.writeByte(LuaTypes.LUA_TBOOLEAN);
                        this.writer.writeByte(c ? 1 : 0);
                        break;
                    case 'number':
                        if (Number.isInteger(c)) {
                            this.writer.writeByte(LuaTypes.LUA_TNUMINT);
                            this.writer.writeInteger(c);
                        } else {
                            this.writer.writeByte(LuaTypes.LUA_TNUMBER);
                            this.writer.writeNumber(c);
                        }
                        break;
                    case 'string':
                        if ((<string>c).length > 255) {
                            this.writer.writeByte(LuaTypes.LUA_TLNGSTR);
                        } else {
                            this.writer.writeByte(LuaTypes.LUA_TSTRING);
                        }

                        this.writer.writeString(c);
                        break;
                    default: throw new Error('Method not implemeneted');
                }
            } else {
                this.writer.writeByte(LuaTypes.LUA_TNIL);
            }
        });
    }

    private emitUpvalues(functionContext: FunctionContext): void {
        this.writer.writeInt(functionContext.upvalues.length);

        functionContext.upvalues.forEach((upvalue: UpvalueInfo, index: number) => {
            // in stack (bool)
            this.writer.writeByte((upvalue.instack) ? 1 : 0);
            // index
            this.writer.writeByte(upvalue.index !== undefined ? upvalue.index : index);
        });
    }

    private emitProtos(functionContext: FunctionContext): void {
        this.writer.writeInt(functionContext.protos.length);

        functionContext.protos.forEach(p => {
            // TODO: finish it
            this.emitFunction(p);
        });
    }

    private emitDebug(functionContext: FunctionContext): void {
        // line info
        this.writer.writeInt(functionContext.code.length);
        functionContext.code.forEach(c => {
            this.writer.writeInt(c[4]);
        });

        // local vars
        // assert
        if (functionContext.debug_locals.length > 0) {
            this.writer.writeInt(functionContext.debug_locals.filter(f => !f.fake).length);
            const firstLocalVarRegister = Math.min(...functionContext.debug_locals.filter(f => !f.fake).map(l => l.register));
            if (firstLocalVarRegister !== Infinity && firstLocalVarRegister > 0) {
                console.error('Local variable does not start from 0');
            }
        } else {
            this.writer.writeInt(0);
        }

        functionContext.debug_locals
            .filter(f => !f.fake)
            .sort((a, b) => {
                if (a.register === b.register) {
                    return a.debugStartCode < b.debugStartCode ? -1 : 1;
                }

                return a.register < b.register ? -1 : 1;
            })
            .forEach(l => {
                this.writer.writeString(l.name);
                this.writer.writeInt(l.debugStartCode + 1);
                this.writer.writeInt(l.debugEndCode + 1);
            });

        // upvalues
        this.writer.writeInt(functionContext.upvalues.length);
        functionContext.upvalues.forEach(u => {
            this.writer.writeString(u.name);
        });
    }
}
