import { Container } from '@cloudflare/containers';
import app from '../../src/index';

export class Issue230PythonContainer extends Container<Env> {
	defaultPort = 8080;
	requiredPorts = [8080];
	sleepAfter = '10s';
	enableInternet = false;
	pingEndpoint = 'issue-230-python/health';
}

export default app;
