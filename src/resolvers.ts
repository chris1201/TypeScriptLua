import * as ts from 'typescript';
import { FunctionContext } from './contexts';
import { Helpers } from './helpers';

export enum ResolvedKind {
    // up values
    Upvalue,
    // const
    Const,
    // registers
    Register,
    // to support methods load
    LoadMember,
    // load array element
    LoadElement,
    // to support loading closures
    Closure
}

export class ResolvedInfo {
    public kind: ResolvedKind;
    public value: any;
    public identifierName: string;
    public node: ts.Node;
    public currentInfo: ResolvedInfo;
    public parentInfo: ResolvedInfo;
    public root: boolean;
    public local: boolean;
    public register: number;
    private constIndex: number;
    private upvalueIndex: number;
    public protoIndex: number;

    public constructor (private functionContext: FunctionContext) {
    }

    public isEmptyRegister(): boolean {
        return this.kind === ResolvedKind.Register && this.register === undefined;
    }

    public ensureConstIndex(): number {
        if (this.kind !== ResolvedKind.Const) {
            throw new Error('It is not Const');
        }

        if (this.constIndex !== undefined) {
            return this.constIndex;
        }

        if (this.value === undefined && this.identifierName === undefined) {
            throw new Error('Value is undefined or IdentifierName to create Const');
        }

        return this.constIndex = -this.functionContext.findOrCreateConst(this.value !== undefined ? this.value : this.identifierName);
    }

    public ensureUpvalueIndex(): number {
        if (this.kind !== ResolvedKind.Upvalue) {
            throw new Error('It is not Upvalue');
        }

        if (this.upvalueIndex !== undefined) {
            return this.upvalueIndex;
        }

        return this.upvalueIndex = -this.functionContext.findOrCreateUpvalue(this.identifierName);
    }

    public getRegisterOrIndex() {
        if (this.kind === ResolvedKind.Register) {
            return this.register;
        }

        if (this.kind === ResolvedKind.Upvalue) {
            return this.ensureUpvalueIndex();
        }

        if (this.kind === ResolvedKind.Closure) {
            return this.protoIndex;
        }

        if (this.kind === ResolvedKind.Const) {
            return this.ensureConstIndex();
        }

        throw new Error('It is not register or const index');
    }

    public getRegister() {
        if (this.kind === ResolvedKind.Register) {
            return this.register;
        }

        throw new Error('It is not register or const index');
    }

    public getUpvalue() {
        if (this.kind === ResolvedKind.Upvalue) {
            return this.ensureUpvalueIndex();
        }

        throw new Error('It is not upvalue');
    }

    public getProto() {
        if (this.kind === ResolvedKind.Closure) {
            return this.protoIndex;
        }

        throw new Error('It is not Closure');
    }
}

export class StackResolver {
    private stack: ResolvedInfo[] = [];

    public constructor(private functionContext: FunctionContext) {
    }

    public push(item: ResolvedInfo) {
        if (!item) {
            throw new Error('Item is not defined');
        }

        this.stack.push(item);
    }

    public pop(): ResolvedInfo {
        const stackItem = this.stack.pop();
        this.functionContext.popRegister(stackItem);
        return stackItem;
    }

    public peek(): ResolvedInfo {
        return this.stack[this.stack.length - 1];
    }
}

export class ScopeContext {
    private scope: any[] = [];

    public push(item: any) {
        if (!item) {
            throw new Error('Item is not defined');
        }

        this.scope.push(item);
    }

    public pop(): any {
        return this.scope.pop();
    }

    public peek(): any {
        return this.scope[this.scope.length - 1];
    }

    public any(): boolean {
        return this.scope.length > 0;
    }

    public anyNotRoot(): boolean {
        return this.scope.length > 1 || this.scope.length > 0 && !this.scope[this.scope.length - 1].root;
    }
}

export class IdentifierResolver {

    public Scope: ScopeContext = new ScopeContext();

    public constructor(private typeChecker: ts.TypeChecker) {
    }

    public resolver(identifier: ts.Identifier, functionContext: FunctionContext): ResolvedInfo {
        if (this.Scope.anyNotRoot()) {
            return this.resolveMemberOfCurrentScope(identifier, functionContext);
        }

        const resolved = (<any>this.typeChecker).resolveName(
            identifier.text, functionContext.location_node, ((1 << 27) - 1)/*mask for all types*/);
        if (resolved) {
            const kind: ts.SyntaxKind = <ts.SyntaxKind>resolved.valueDeclaration.kind;
            switch (kind) {
                case ts.SyntaxKind.VariableDeclaration:
                    const type = resolved.valueDeclaration.type;
                    // can be keyward to 'string'
                    if (type && type.typeName) {
                        switch (type.typeName.text) {
                            case 'Console':
                                return this.returnResolvedEnv(functionContext);
                        }
                    }

                    // values are not the same as Node.Flags
                    if (resolved.flags !== 2) {
                        return this.resolveMemberOfCurrentScope(identifier, functionContext);
                    } else {
                        const resolvedInfo = new ResolvedInfo(functionContext);
                        resolvedInfo.kind = ResolvedKind.Register;
                        resolvedInfo.identifierName = identifier.text;
                        resolvedInfo.register = functionContext.findLocal(resolvedInfo.identifierName);
                        resolvedInfo.local = true;
                        return resolvedInfo;
                    }

                    break;

                case ts.SyntaxKind.FunctionDeclaration:
                    return this.resolveMemberOfCurrentScope(identifier, functionContext);
            }
        }

        // TODO: hack
        throw new Error('Could not resolve: ' + identifier.text);
    }

    public returnResolvedEnv(functionContext: FunctionContext, root?: boolean): ResolvedInfo {
        const resolvedInfo = new ResolvedInfo(functionContext);
        resolvedInfo.kind = ResolvedKind.Upvalue;
        resolvedInfo.identifierName = '_ENV';
        resolvedInfo.root = root;
        resolvedInfo.ensureUpvalueIndex();
        return resolvedInfo;
    }

    private resolveMemberOfCurrentScope(identifier: ts.Identifier, functionContext: FunctionContext): ResolvedInfo {
        if (!this.Scope.any()) {
            this.Scope.push(this.returnResolvedEnv(functionContext, true));
        }

        const parentScope: any = this.Scope.peek();
        if (parentScope && parentScope.kind === ResolvedKind.Upvalue) {
            const resolvedInfo = new ResolvedInfo(functionContext);
            resolvedInfo.kind = ResolvedKind.Const;
            resolvedInfo.identifierName = identifier.text;

            // resolve _ENV
            // TODO: hack
            if (parentScope.identifierName === '_ENV') {
                switch (resolvedInfo.identifierName) {
                    case 'log': resolvedInfo.identifierName = 'print'; break;
                }
            }

            if (!parentScope.root) {
                return resolvedInfo;
            }

            const finalResolvedInfo = new ResolvedInfo(functionContext);
            finalResolvedInfo.kind = ResolvedKind.LoadMember;
            finalResolvedInfo.parentInfo = parentScope;
            finalResolvedInfo.currentInfo = resolvedInfo;
            return finalResolvedInfo;
        }

        throw new Error('Method not implemented');
    }
}
