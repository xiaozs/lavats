import { Ast, TerminalAst, RepeatAst, MoreAst, OptionalAst, EndAst, ChildrenAst } from "./Ast";
import type { Rule, TerminalRule, DelayRule } from "./Rule";
import { UnreachableError } from "./utils/utils";

export type MatchResult =
    | MatchFail
    | MatchSuccess
    | MatchContinue

export enum MatchState {
    fail,
    success,
    continue
}

export interface MatchFail {
    state: MatchState.fail;
    retry: Ast[];
}

export interface MatchSuccess {
    state: MatchState.success;
    ast: Ast[];
    retry?: Ast[];
}

export interface MatchContinue {
    state: MatchState.continue;
    retry?: Ast[]
}

export interface PushFn {
    (rule: Rule): void;
}

export interface IsLeftRecursion {
    (): boolean;
}

export abstract class Matcher {
    abstract match(ast: Ast, push: PushFn, isLeftRecursion: IsLeftRecursion): MatchResult;
    abstract onChildrenResult(res: MatchResult, push: PushFn): MatchResult;
}

export class EndMatcher extends Matcher {
    match(ast: Ast): MatchResult {
        if (ast instanceof EndAst) {
            return {
                state: MatchState.success,
                ast: []
            }
        } else {
            return {
                state: MatchState.fail,
                retry: [ast]
            }
        }
    }
    onChildrenResult(res: MatchResult, push: PushFn): MatchResult {
        throw new UnreachableError();
    }
}

export class TerminalMatcher extends Matcher {
    constructor(private rule: TerminalRule) {
        super();
    }
    match(ast: Ast): MatchResult {
        // if (ast instanceof ChildrenAst) {
        //     return {
        //         state: MatchState.continue,
        //         retry: ast.children
        //     }
        // }

        if (ast instanceof TerminalAst && ast.rule === this.rule) {
            return {
                state: MatchState.success,
                ast: [ast]
            }
        } else {
            return {
                state: MatchState.fail,
                retry: [ast]
            }
        }
    }
    onChildrenResult(res: MatchResult): MatchResult {
        throw new UnreachableError();
    }
}

export class DelayMatcher extends Matcher {
    constructor(readonly delayRule: DelayRule<any>, private maybeLeftRecursion: boolean) {
        super();
    }
    match(ast: Ast, push: PushFn, isLeftRecursion: IsLeftRecursion): MatchResult {
        if (ast instanceof this.delayRule.ast) {
            return {
                state: MatchState.success,
                ast: [ast]
            }
        }

        if (this.maybeLeftRecursion && isLeftRecursion()) {
            return {
                state: MatchState.fail,
                retry: [ast]
            }
        }

        push(this.delayRule.rule);
        return {
            state: MatchState.continue,
            retry: [ast]
        }
    }

    private cache?: Ast;
    onChildrenResult(res: MatchResult, push: PushFn): MatchResult {
        if (res.state === MatchState.success) {
            let ast = new this.delayRule.ast(res.ast);
            if (this.maybeLeftRecursion) {
                this.cache = ast;
                push(this.delayRule.rule);
                return {
                    state: MatchState.continue,
                    retry: [ast, ...res.retry ?? []]
                }
            } else {
                return {
                    ...res,
                    ast: [ast]
                }
            }
        }
        if (res.state === MatchState.fail && this.cache) {
            res.retry.shift();
            return {
                state: MatchState.success,
                ast: [this.cache],
                retry: res.retry,
            }
        }
        return res;
    }
}

enum AndOrState {
    init,
    left,
    right
}

export class AndMatcher extends Matcher {
    constructor(private left: Rule, private right: Rule) {
        super();
    }
    private state = AndOrState.init;
    get isRight() {
        return this.state === AndOrState.right;
    }

    match(ast: Ast, push: PushFn): MatchResult {
        switch (this.state) {
            case AndOrState.init:
                push(this.left);
                this.state = AndOrState.left;
                break;
            case AndOrState.left:
                push(this.right);
                this.state = AndOrState.right;
                break
            default:
                throw new UnreachableError();
        }
        return {
            state: MatchState.continue,
            retry: [ast]
        }
    }

    private leftAst!: Ast[];
    onChildrenResult(res: MatchResult): MatchResult {
        switch (this.state) {
            case AndOrState.left:
                if (res.state === MatchState.success) {
                    this.leftAst = res.ast;
                    return {
                        state: MatchState.continue,
                        retry: res.retry
                    }
                }
                return res;
            case AndOrState.right:
                if (res.state === MatchState.success) {
                    return {
                        ...res,
                        ast: this.leftAst.concat(res.ast)
                    }
                }
                if (res.state === MatchState.fail) {
                    return {
                        ...res,
                        retry: this.leftAst.concat(res.retry)
                    }
                }
                return res;
            default:
                throw new UnreachableError();
        }
    }
}

export class OrMatcher extends Matcher {
    constructor(private left: Rule, private right: Rule) {
        super();
    }
    private state = AndOrState.init;
    match(ast: Ast, push: PushFn): MatchResult {
        switch (this.state) {
            case AndOrState.init:
                push(this.left);
                this.state = AndOrState.left;
                break;
            case AndOrState.left:
                push(this.right);
                this.state = AndOrState.right;
                break
            default:
                throw new UnreachableError();
        }
        return {
            state: MatchState.continue,
            retry: [ast]
        }
    }
    onChildrenResult(res: MatchResult): MatchResult {
        switch (this.state) {
            case AndOrState.left:
                if (res.state === MatchState.fail) {
                    return {
                        ...res,
                        state: MatchState.continue,
                    }
                }
                return res;
            case AndOrState.right:
                return res;
            default:
                throw new UnreachableError();
        }
    }
}

export class RepeatMatcher extends Matcher {
    constructor(private rule: Rule) {
        super();
    }
    match(ast: Ast, push: PushFn): MatchResult {
        push(this.rule);
        return {
            state: MatchState.continue,
            retry: [ast]
        }
    }
    private cache: Ast[] = [];
    onChildrenResult(res: MatchResult, push: PushFn): MatchResult {
        if (res.state === MatchState.fail) {
            return {
                state: MatchState.success,
                ast: [new RepeatAst(this.cache)],
                retry: res.retry
            }
        }
        if (res.state === MatchState.success) {
            this.cache.push(...res.ast);
            push(this.rule);
            return {
                state: MatchState.continue,
                retry: res.retry
            }
        }
        return res;
    }
}

export class MoreMatcher extends Matcher {
    constructor(private rule: Rule) {
        super();
    }
    match(ast: Ast, push: PushFn): MatchResult {
        push(this.rule);
        return {
            state: MatchState.continue,
            retry: [ast]
        }
    }
    private cache: Ast[] = [];
    onChildrenResult(res: MatchResult, push: PushFn): MatchResult {
        if (res.state === MatchState.fail) {
            if (this.cache.length) {
                return {
                    state: MatchState.success,
                    ast: [new MoreAst(this.cache)],
                    retry: res.retry
                }
            } else {
                return res;
            }
        }
        if (res.state === MatchState.success) {
            this.cache.push(...res.ast);
            push(this.rule);
            return {
                state: MatchState.continue,
                retry: res.retry
            }
        }
        return res;
    }
}

export class OptionalMatcher extends Matcher {
    constructor(private rule: Rule) {
        super();
    }
    match(ast: Ast, push: PushFn): MatchResult {
        push(this.rule);
        return {
            state: MatchState.continue,
            retry: [ast]
        }
    }
    onChildrenResult(res: MatchResult): MatchResult {
        if (res.state === MatchState.fail) {
            return {
                state: MatchState.success,
                ast: [new OptionalAst([])],
                retry: res.retry
            }
        }
        if (res.state === MatchState.success) {
            return {
                ...res,
                ast: [new OptionalAst(res.ast)]
            }
        }
        return res;
    }
}