import type { InMemorySigner, keyStores, Near, WalletConnection } from 'near-api-js';
import { KeyPair, utils } from 'near-api-js';
import { ConnectedWalletAccount } from 'near-api-js';
import { deserialize } from 'near-api-js/lib/utils/serialize';
import type { Transaction } from '@near-js/transactions';
import { SCHEMA, SignedDelegate } from '@near-js/transactions';

const LOGIN_WALLET_URL_SUFFIX = '/login/';
const LOCAL_STORAGE_KEY_SUFFIX = '_wallet_auth_key';
const PENDING_ACCESS_KEY_PREFIX = 'pending_key'; // browser storage key for a pending access key (i.e. key has been generated but we are not sure it was added yet)

interface SignInOptions {
  contractId?: string;
  methodNames?: string[];
  // TODO: Replace following with single callbackUrl
  successUrl?: string;
  failureUrl?: string;
  email?: string;
  accountId?: string;
  isRecovery?: boolean;
}

/**
 * Information to send NEAR wallet for signing transactions and redirecting the browser back to the calling application
 */
interface RequestSignTransactionsOptions {
  /** list of transactions to sign */
  transactions: Transaction[];
  /** url NEAR Wallet will redirect to after transaction signing is complete */
  callbackUrl?: string;
  /** meta information NEAR Wallet will send back to the application. `meta` will be attached to the `callbackUrl` as a url search param */
  meta?: string;
}

const createDialog = (): HTMLDialogElement => {
  const myDialog = document.createElement('dialog');
  myDialog.style.width = '50%';
  myDialog.style.height = '50%';
  myDialog.style.minWidth = '350px';
  myDialog.style.minHeight = '500px';
  return myDialog;
}

export class FastAuthWalletConnection {
  /** @hidden */
  _walletBaseUrl: string;

  /** @hidden */
  _authDataKey: string;

  /** @hidden */
  _keyStore: keyStores.KeyStore;

  /** @hidden */
  _authData: { accountId?: string; allKeys?: string[] };

  /** @hidden */
  _networkId: string;

  /** @hidden */
  // _near: Near;
  _near: Near;

  /** @hidden */
  _connectedAccount: ConnectedWalletAccount;

  /** @hidden */
  _completeSignInPromise: Promise<void>;

  /** @hidden */
  _iframe: HTMLIFrameElement;

  constructor(near: Near, appKeyPrefix: string) {
    if (typeof appKeyPrefix !== 'string') {
      throw new Error(
        'Please define a clear appKeyPrefix for this WalletConnection instance as the second argument to the constructor',
      );
    }

    if (typeof window === 'undefined') {
      return new Proxy(this, {
        get(target, property) {
          if (property === 'isSignedIn') {
            return () => false;
          }
          if (property === 'getAccountId') {
            return () => '';
          }
          if (
            target[property as keyof FastAuthWalletConnection] &&
            typeof target[property as keyof FastAuthWalletConnection] === 'function'
          ) {
            return () => {
              throw new Error(
                'No window found in context, please ensure you are using WalletConnection on the browser',
              );
            };
          }
          return target[property as keyof FastAuthWalletConnection];
        },
      });
    }
    const iframe = document.createElement('iframe');
    iframe.allow = 'publickey-credentials-get *; clipboard-write';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    this._iframe = iframe;
    this._near = near;
    const authDataKey = appKeyPrefix + LOCAL_STORAGE_KEY_SUFFIX;
    const authData = JSON.parse(window.localStorage.getItem(authDataKey) as string);
    this._networkId = near.config.networkId;
    this._walletBaseUrl = near.config.walletUrl;
    appKeyPrefix = appKeyPrefix || near.config.contractName || 'default';
    this._keyStore = (near.connection.signer as InMemorySigner).keyStore;
    this._authData = authData || { allKeys: [] };
    this._authDataKey = authDataKey;
    if (!this.isSignedIn()) {
      this._completeSignInPromise = this._completeSignInWithAccessKey();
    }
  }

  /**
   * Returns true, if this WalletConnection is authorized with the wallet.
   * @example
   * ```js
   * const wallet = new WalletConnection(near, 'my-app');
   * wallet.isSignedIn();
   * ```
   */
  isSignedIn() {
    return !!this._authData.accountId;
  }

  /**
   * Returns promise of completing signing in after redirecting from wallet
   * @example
   * ```js
   * // on login callback page
   * const wallet = new WalletConnection(near, 'my-app');
   * wallet.isSignedIn(); // false
   * await wallet.isSignedInAsync(); // true
   * ```
   */
  async isSignedInAsync() {
    if (!this._completeSignInPromise) {
      return this.isSignedIn();
    }

    await this._completeSignInPromise;
    return this.isSignedIn();
  }

  /**
   * Returns authorized Account ID.
   * @example
   * ```js
   * const wallet = new WalletConnection(near, 'my-app');
   * wallet.getAccountId();
   * ```
   */
  getAccountId() {
    return this._authData.accountId || '';
  }

  /**
   * Redirects current page to the wallet authentication page.
   * @param options An optional options object
   * @param options.contractId The NEAR account where the contract is deployed
   * @param options.successUrl URL to redirect upon success. Default: current url
   * @param options.failureUrl URL to redirect upon failure. Default: current url
   *
   * @example
   * ```js
   * const wallet = new WalletConnection(near, 'my-app');
   * // redirects to the NEAR Wallet
   * wallet.requestSignIn({ contractId: 'account-with-deploy-contract.near' });
   * ```
   */
  async requestSignIn({
    contractId,
    methodNames,
    successUrl,
    failureUrl,
    email,
    accountId,
    isRecovery,
  }: SignInOptions) {
    const currentUrl = new URL(window.location.href);
    const newUrl = new URL(this._walletBaseUrl + LOGIN_WALLET_URL_SUFFIX);
    newUrl.searchParams.set('success_url', successUrl || currentUrl.href);
    newUrl.searchParams.set('failure_url', failureUrl || currentUrl.href);
    if (contractId) {
      /* Throws exception if contract account does not exist */
      const contractAccount = await this._near.account(contractId);
      await contractAccount.state();

      newUrl.searchParams.set('contract_id', contractId);
      const accessKey = KeyPair.fromRandom('ed25519');
      newUrl.searchParams.set('public_key', accessKey.getPublicKey().toString());
      await this._keyStore.setKey(this._networkId, PENDING_ACCESS_KEY_PREFIX + accessKey.getPublicKey(), accessKey);
    }

    if (methodNames) {
      methodNames.forEach((methodName) => {
        newUrl.searchParams.append('methodNames', methodName);
      });
    }

    if (email) {
      newUrl.searchParams.append('email', email);
    }
    if (accountId) {
      newUrl.searchParams.append('accountId', accountId);
    }
    if (isRecovery !== undefined) {
      newUrl.searchParams.append('isRecovery', isRecovery + '');
    }

    if (!isRecovery) {
      window.location.replace(newUrl.toString());
      return;
    }

    const preBiometricAuthAccount = await new Promise(resolve => {
      const requestId = 1234;
      this._iframe.src =  new URL(this._walletBaseUrl + '/rpc/').toString();
      document.body.appendChild(this._iframe);
      const listener = (e: MessageEvent) => {
        if (
          e.data.method === 'ready'
        ) {
          this._iframe.contentWindow?.postMessage({
            type: 'method',
            method: 'query',
            id: requestId,
            params: {
              request_type: 'get_pre_biometric_auth_account'
            }
          },'*');
        }
        if (
          e.data.id === requestId
        ) {
          window.removeEventListener('message', listener);
          resolve(e.data.result);
        }
      };
      window.addEventListener('message', listener);
    });

    if (preBiometricAuthAccount !== email) {
      window.location.replace(newUrl.toString());
    } else {
      this._iframe.src = newUrl.toString();
      const myDialog = createDialog();
      document.body.appendChild(myDialog);
      myDialog.appendChild(this._iframe);
      myDialog.showModal();
      myDialog.addEventListener('click', function (event) {
        const rect = myDialog.getBoundingClientRect();
        const isInDialog =
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width;
        if (!isInDialog) {
          myDialog.close();
        }
      });
      const { publicKey, allKeys, accountId } = await new Promise((resolve) => {
        const listener = (e: MessageEvent) => {
          if (
            e.data.params && e.data.params.request_type === 'complete_sign_in'
          ) {
            window.removeEventListener('message', listener);
            resolve({ publicKey: e.data.params.publicKey, allKeys: e.data.params.allKeys, accountId: e.data.params.accountId });
          }
        };
        window.addEventListener('message', listener);
      }) as {publicKey: string; allKeys: string; accountId: string;};
      currentUrl.searchParams.append('public_key', publicKey);
      currentUrl.searchParams.append('all_keys', allKeys);
      currentUrl.searchParams.append('account_id', accountId);
      window.location.replace(currentUrl);
    }
  }

  /**
   * Requests the user to quickly sign for a transaction or batch of transactions by redirecting to the NEAR wallet.
   */
  async requestSignTransactions({
    transactions,
    meta,
    callbackUrl,
  }: RequestSignTransactionsOptions): Promise<{ signedDelegates: SignedDelegate[]; closeDialog: () => void; error?: string; }> {
    const currentUrl = new URL(window.location.href);
    const newUrl = new URL(this._walletBaseUrl + '/sign/');

    newUrl.searchParams.set(
      'transactions',
      transactions
        .map((transaction) => utils.serialize.serialize(SCHEMA, transaction))
        .map((serialized) => Buffer.from(serialized).toString('base64'))
        .join(','),
    );
    newUrl.searchParams.set('success_url', callbackUrl || currentUrl.href);
    newUrl.searchParams.set('failure_url', callbackUrl || currentUrl.href);
    if (meta) newUrl.searchParams.set('meta', meta);

    this._iframe.src = newUrl.toString();
    const myDialog = createDialog()
    document.body.appendChild(myDialog);
    myDialog.appendChild(this._iframe);
    myDialog.showModal();
    myDialog.addEventListener('click', function (event) {
      const rect = myDialog.getBoundingClientRect();
      const isInDialog =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (!isInDialog) {
        myDialog.close();
      }
    });
    return new Promise((resolve) => {
      const listener = (e: MessageEvent) => {
        if (
          e.data.signedDelegates &&
          (e.data.signedDelegates
            .split(',')
            .some((s: string) =>
              deserialize(SCHEMA, SignedDelegate, Buffer.from(s, 'base64')),
            ) ||
            e.data.signedDelegates.length === 0)
        ) {
          window.removeEventListener('message', listener);
          resolve({
            signedDelegates: e.data.signedDelegates
              .split(',')
              .map((s: string) => deserialize(SCHEMA, SignedDelegate, Buffer.from(s, 'base64'))),
            closeDialog: () => myDialog.close(),
            error: e.data.error
          });
        }
      };
      window.addEventListener('message', listener);
    });
  }

  /**
   * @hidden
   * Complete sign in for a given account id and public key. To be invoked by the app when getting a callback from the wallet.
   */
  async _completeSignInWithAccessKey() {
    const currentUrl = new URL(window.location.href);
    const publicKey = currentUrl.searchParams.get('public_key') || '';
    const allKeys = (currentUrl.searchParams.get('all_keys') || '').split(',');
    const accountId = currentUrl.searchParams.get('account_id') || '';
    // TODO: Handle errors during login
    if (accountId) {
      const authData = {
        accountId,
        allKeys,
      };
      window.localStorage.setItem(this._authDataKey, JSON.stringify(authData));
      if (publicKey) {
        await this._moveKeyFromTempToPermanent(accountId, publicKey);
      }
      this._authData = authData;
    }
    currentUrl.searchParams.delete('public_key');
    currentUrl.searchParams.delete('all_keys');
    currentUrl.searchParams.delete('account_id');
    currentUrl.searchParams.delete('meta');
    currentUrl.searchParams.delete('transactionHashes');

    window.history.replaceState({}, document.title, currentUrl.toString());
  }

  /**
   * @hidden
   * @param accountId The NEAR account owning the given public key
   * @param publicKey The public key being set to the key store
   */
  async _moveKeyFromTempToPermanent(accountId: string, publicKey: string) {
    const keyPair = await this._keyStore.getKey(this._networkId, PENDING_ACCESS_KEY_PREFIX + publicKey);
    await this._keyStore.setKey(this._networkId, accountId, keyPair);
    await this._keyStore.removeKey(this._networkId, PENDING_ACCESS_KEY_PREFIX + publicKey);
  }

  /**
   * Sign out from the current account
   * @example
   * walletConnection.signOut();
   */
  signOut() {
    this._authData = {};
    window.localStorage.removeItem(this._authDataKey);
  }

  /**
   * Returns the current connected wallet account
   */
  account() {
    if (!this._connectedAccount) {
      this._connectedAccount = new ConnectedWalletAccount(
        this as unknown as WalletConnection,
        this._near.connection,
        this._authData.accountId as string,
      );
    }
    return this._connectedAccount;
  }
}
