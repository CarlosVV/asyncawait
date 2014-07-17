﻿import references = require('references');
import assert = require('assert');
import Fiber = require('fibers');
import _ = require('./util');
import Pipeline = AsyncAwait.Pipeline;
import Protocol = AsyncAwait.Async.Protocol;
export = pipeline;


// Default implementations for the overrideable pipeline methods.
var defaultPipeline: Pipeline = {

    /** Create and return a new Coroutine instance. */
    acquireCoro: (protocol: Protocol, bodyFunc: Function, bodyArgs?: any[], bodyThis?: any) => {
        var fiberBody = pipeline.createFiberBody(protocol, () => co);
        var co = <CoroFiber> pipeline.acquireFiber(fiberBody);
        co.bodyFunc = bodyFunc;
        co.bodyArgs = bodyArgs;
        co.bodyThis = bodyThis;
        co.context = {};
        co.enter = function enter(error?, value?) {
            if (_.DEBUG) assert(!pipeline.isCurrent(co), 'enter: must not be called from the currently executing coroutine');
            if (error) setImmediate(() => { co.throwInto(error); });
            else setImmediate(() => { co.run(value); });
        };
        co.leave = function leave(value?) {
            if (_.DEBUG) assert(pipeline.isCurrent(co), 'enter: may only be called from the currently executing coroutine');
            value = protocol.yield(co.context, value);
            if (value === pipeline.continueAfterYield) return;
            pipeline.suspendCoro(value);
        };
        return co;
    },

    /** Ensure the Coroutine instance is disposed of cleanly. */
    releaseCoro: (co: CoroFiber) => {
        co.enter = null;
        co.leave = null;
        co.context = null;
    },

    /** Create and return a new Fiber instance. */
    acquireFiber: (body: () => any): Fiber => {
        return Fiber(body);
    },

    /** Ensure the Fiber instance is disposed of cleanly. */
    releaseFiber: (fiber: Fiber) => {
        // NB: Nothing to do here in this default implementation.
    },

    /** Create the body function to be executed inside a fiber. */
    createFiberBody: (protocol: Protocol, getCo: () => CoroFiber) => {

        // V8 may not optimise the following function due to the presence of
        // try/catch/finally. Therefore it does as little as possible, only
        // referencing the optimisable closures prepared below.
        function fiberBody() {
            try { tryBlock(); }
            catch (err) { catchBlock(err); }
            finally { finallyBlock(); }
        };

        // Shared reference to coroutine, which is only available after getCo() is called.
        var co: CoroFiber;

        // Define the details of the body function's try/catch/finally clauses.
        var tryBlock = () => {

            // Lazy-load the coroutine instance to use throughout the body function. This mechanism
            // means that the instance need not be available at the time createFiberBody() is called.
            co = getCo();

            // Execute the entirety of bodyFunc, then perform the protocol-specific return operation.
            var slowCall = (co.bodyArgs && co.bodyArgs.length) || (co.bodyThis && co.bodyThis !== global);
            //TODO: use ?: operator
            if (slowCall) {
                var result = co.bodyFunc.apply(co.bodyThis, co.bodyArgs);
            } else {
                result = co.bodyFunc();
            }
            protocol.return(co.context, result);
        };
        var catchBlock = err => {

            // Handle exceptions in a protocol-defined manner.
            protocol.throw(co.context, err);
        };
        var finallyBlock = () => {

            // Ensure the fiber exits before we clean it up.
            setImmediate(() => {
                pipeline.releaseFiber(co);
                pipeline.releaseCoro(co);
            });
        };

        // Return the completed fiberBody closure.
        return fiberBody;
    }
}


/**
 *  A hash of functions and properties that are used internally by asyncawait at
 *  various stages of handling asynchronous functions. These can be augmented with
 *  the use(...) method on asyncawait's primary export.
 */
var pipeline = {

    // The following methods comprise the overridable pipeline API.
    acquireCoro: defaultPipeline.acquireCoro,
    releaseCoro: defaultPipeline.releaseCoro,
    acquireFiber: defaultPipeline.acquireFiber,
    releaseFiber: defaultPipeline.releaseFiber,
    createFiberBody: defaultPipeline.createFiberBody,

    // The remaining items are for internal use and must not be overriden.
    currentCoro: () => <CoroFiber> Fiber.current,
    suspendCoro: (val?) => Fiber.yield(val),
    isCurrent: <(co: CoroFiber) => boolean> isCurrentCoro,
    continueAfterYield: {}, /* sentinal value */
    notHandled: {}, /* sentinal value */
    reset: <() => void> resetPipeline,
    isLocked: false,
    mods: []
};


/** Reset the pipeline to its default state. This is useful for unit testing. */
function resetPipeline() {

    // Restore the methods from the default pipeline.
    _.mergeProps(pipeline, defaultPipeline);

    // 'Forget' all applied mods.
    pipeline.mods = [];

    // Unlock the pipeline so that use(...) calls can be made again.
    pipeline.isLocked = false;
}


function isCurrentCoro(co: CoroFiber) {
    var current = <CoroFiber> Fiber.current;
    return current && current.context === co.context;
}
