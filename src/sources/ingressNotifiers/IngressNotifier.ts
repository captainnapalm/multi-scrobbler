import winston, {Logger} from '@foxxmd/winston';
import {mergeArr, remoteHostIdentifiers, remoteHostStr} from "../../utils.js";
import {Request} from "express";
import {RemoteIdentityParts} from "../../common/infrastructure/Atomic.js";


export abstract class IngressNotifier {

    identifier: string;
    logger: Logger;

    remotes: Record<string, RemoteIdentityParts> = {};

    protected constructor(name: string) {
        this.identifier = name;
        this.logger =  winston.loggers.get('app').child({labels: ['Ingress', name]}, mergeArr);
    }

    public trackIngress(req: Request, isRaw: boolean) {
        const parts = remoteHostIdentifiers(req);
        const id = `${parts.host}-${parts.proxy ?? ''}`;

        const notifs: string[] = [];

        const newRemote = this.remotes[id] === undefined;
        if (newRemote) {
            this.remotes[id] = parts;
            notifs.push(`Received request from a new remote address: ${remoteHostStr(req)}`);
        }
        const requestNotif = this.notifyByRequest(req, isRaw);
        if (requestNotif !== undefined) {
            notifs.push(`${!newRemote ? remoteHostStr(req) : ''} ${requestNotif}`);
        }
        const [sourceValid, sourceNotif] = this.notifyBySource(req, isRaw);
        if (sourceNotif !== undefined) {
            notifs.push(`${!newRemote && requestNotif === undefined ? `${remoteHostStr(req)} ` : ''}${sourceNotif}`);
        }

        if(notifs.length > 0) {
            if (requestNotif !== undefined || sourceValid === false) {
                this.logger.warn(notifs.join(' | '));
            } else {
                this.logger.info(notifs.join(' | '))
            }
        }
    }

    notifyByRequest(req: Request, isRaw: boolean): string | undefined {
        return;
    }

    abstract notifyBySource(req: Request, isRaw: boolean): [boolean, string | undefined];
}
