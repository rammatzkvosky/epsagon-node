const uuid4 = require('uuid4');
const tryRequire = require('try-require');
const serverlessEvent = require('../proto/event_pb.js');
const utils = require('../utils.js');

const mongodb = tryRequire('mongodb');
const tracer = require('../tracer.js');
const errorCode = require('../proto/error_code_pb.js');
const eventInterface = require('../event.js');

const requestsResolvers = {};

/**
 * Hook for mongodb requests starting
 * @param {Object} event The request event
 */
function onStartHook(event) {
    try {
        const startTime = Date.now();

        let { host, port } = event.connectionId;
        if (!host) {
            [host, port] = event.connectionId.split(':');
        }

        const resource = new serverlessEvent.Resource([
            host,
            'mongodb',
            event.commandName,
        ]);
        const dbapiEvent = new serverlessEvent.Event([
            `mongodb-${uuid4()}`,
            utils.createTimestampFromTime(startTime),
            null,
            'mongodb',
            0,
            errorCode.ErrorCode.OK,
        ]);
        dbapiEvent.setResource(resource);

        let collection = event.command.collection || event.command[event.commandName];
        if (typeof collection !== 'string') {
            collection = '';
        }
        eventInterface.addToMetadata(dbapiEvent, {
            port,
            namespace: `${event.databaseName}.${collection}`,
        });

        const responsePromise = new Promise((resolve) => {
            requestsResolvers[event.requestId] = { resolve, dbapiEvent };
        });

        tracer.addEvent(dbapiEvent, responsePromise);
    } catch (error) {
        tracer.addException(error);
    }
}

/**
 * Handle a mongodb response
 * @param {Object} event The response  event
 * @param {boolean} hasError True if the request failed
 */
function handleEventResponse(event, hasError) {
    try {
        const { resolve, dbapiEvent } = requestsResolvers[event.requestId];

        dbapiEvent.setDuration(event.duration);
        if (hasError) {
            dbapiEvent.addException({
                name: 'Mongodb Error',
                message: '',
                stack: [],
            });
        }

        delete requestsResolvers[event.requestId];
        resolve();
    } catch (error) {
        tracer.addException(error);
    }
}

/**
 * Hook for mongodb requests ending successfully
 * @param {Object} event The response event
 */
function onSuccessHook(event) {
    handleEventResponse(event);
}

/**
 * Hook for mongodb requests ending with failure
 * @param {Object} event The response event
 */
function onFailureHook(event) {
    handleEventResponse(event, true);
}

module.exports = {
    /**
     * Initializes mongodb instrumentation
     */
    init() {
        if (mongodb) {
            const listener = mongodb.instrument({}, (error) => {
                if (error) { utils.debugLog(error); }
            });
            listener.on('started', onStartHook);
            listener.on('succeeded', onSuccessHook);
            listener.on('failed', onFailureHook);
        }
    },
};