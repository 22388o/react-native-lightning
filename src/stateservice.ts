import { NativeModules, NativeModulesStatic } from 'react-native';
import GrpcAction from './grpc';
import { err, ok, Result } from './utils/result';
import { EGrpcStreamMethods, EGrpcSyncMethods } from './utils/types';
import { ss_lnrpc as stateservice_lnrpc } from './protos/stateservice';

class StateService {
	private readonly grpc: GrpcAction;
	private readonly lnd: NativeModulesStatic;

	constructor() {
		this.lnd = NativeModules.ReactNativeLightning;
		this.grpc = new GrpcAction(this.lnd);
	}

	readableState(state: stateservice_lnrpc.WalletState): string {
		switch (state) {
			case stateservice_lnrpc.WalletState.RPC_ACTIVE:
				return 'RPC active';
			case stateservice_lnrpc.WalletState.NON_EXISTING:
				return 'Non existing wallet';
			case stateservice_lnrpc.WalletState.LOCKED:
				return 'Wallet locked';
			case stateservice_lnrpc.WalletState.UNLOCKED:
				return 'Wallet unlocked';
			case stateservice_lnrpc.WalletState.WAITING_TO_START:
				return 'Waiting to start';
			default:
				return `Unknown state (${state})`;
		}
	}

	/**
	 * Returns current state for LND wallet.
	 * If no state is returned from LND then assumes state is WAITING_TO_START
	 * @returns {Promise<Ok<lnrpc.WalletState> | Err<unknown>>}
	 */
	async getState(): Promise<Result<stateservice_lnrpc.WalletState>> {
		return await new Promise((resolve, reject) => {
			// If there's no response from LND we assume the wallet has not been started
			const timeout = setTimeout(() => {
				resolve(ok(stateservice_lnrpc.WalletState.WAITING_TO_START));
			}, 250);

			this.grpc
				.sendCommand(
					EGrpcSyncMethods.GetState,
					stateservice_lnrpc.GetStateRequest.encode(
						stateservice_lnrpc.GetStateRequest.create()
					).finish()
				)
				.then((res) => {
					resolve(ok(stateservice_lnrpc.GetStateResponse.decode(res).state));
				})
				.catch((e) => {
					reject(err(e));
				})
				.finally(() => {
					// Received a response so cancel default timeout
					clearTimeout(timeout);
				});
		});
	}

	/**
	 * LND subscribe to any LND daemon state changes
	 * @param onUpdate
	 * @param onDone
	 */
	subscribeToStateChanges(
		onUpdate: (res: Result<stateservice_lnrpc.WalletState>) => void,
		onDone: (res: Result<boolean>) => void
	): void {
		try {
			const refreshState = (): void => {
				this.getState()
					.then((res) => {
						if (res.isOk()) {
							onUpdate(ok(res.value));
						}
					})
					.catch((e) => {
						onUpdate(err(e));
					});
			};

			// Decode the response before sending update back
			const onStateUpdate = (res: Result<Uint8Array>): void => {
				if (res.isErr()) {
					onUpdate(err(res.error));
					return;
				}

				onUpdate(ok(stateservice_lnrpc.SubscribeStateResponse.decode(res.value).state));
			};

			// State is usually subscribed to as soon as LND is started but will
			// fail if there isn't a small delay between starting and checking the state is "STARTED"
			setTimeout(() => {
				this.grpc.sendStreamCommand(
					EGrpcStreamMethods.SubscribeState,
					stateservice_lnrpc.GetStateRequest.encode(
						stateservice_lnrpc.GetStateRequest.create()
					).finish(),
					onStateUpdate,
					(res) => {
						// Last refresh (If lnd was stopped then we want to get one last state update)
						refreshState();
						onDone(res);
					}
				);

				// Update the state at least once each time a new subscription is created
				refreshState();
			}, 250);
		} catch (e) {
			onUpdate(err(e));
		}
	}
}

export default new StateService();
