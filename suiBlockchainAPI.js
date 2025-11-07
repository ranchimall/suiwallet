const suiBlockchainAPI = {
  //  Get Balance
  async getBalance(address, coinType = "0x2::sui::SUI") {
    const res = await fetch("https://fullnode.mainnet.sui.io:443", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "suix_getBalance",
        params: [address, coinType],
      }),
    });
    const json = await res.json();
    return json?.result?.totalBalance || 0;
  },
  // Get Transaction History
  async getTransactionHistory(address, cursor = null, limit = 10) {
    const SUI_RPC_URL = "https://fullnode.mainnet.sui.io:443";

    try {
      //Query transaction digests using ToAddress filter
      const res = await fetch(SUI_RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "suix_queryTransactionBlocks",
          params: [
            {
              filter: { ToAddress: address },
            },
            cursor,
            limit,
            true,
          ],
        }),
      });

      const json = await res.json();
      if (json.error) throw new Error(json.error.message);

      const digests = json.result?.data?.map((d) => d.digest) || [];
      const nextCursor = json.result?.nextCursor || null;
      const hasNextPage = !!json.result?.hasNextPage;

      //Fetch detailed information for each transaction
      const details = await Promise.all(
        digests.map(async (digest) => {
          try {
            const detailRes = await fetch(SUI_RPC_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "sui_getTransactionBlock",
                params: [
                  digest,
                  {
                    showInput: true,
                    showEffects: true,
                    showBalanceChanges: true,
                    showEvents: true,
                  },
                ],
              }),
            });
            const detailJson = await detailRes.json();
            return detailJson.result;
          } catch (err) {
            console.warn(`Failed to fetch details for digest ${digest}:`, err);
            return null;
          }
        })
      );

      // Remove null results
      const validDetails = details.filter(Boolean);

      // Sort by timestamp descending (newest first)
      validDetails.sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));

      // Transform to the expected format
      const transactions = validDetails.map((tx) => {
        const from = tx.transaction?.data?.sender || "Unknown";
        const balanceChanges = tx.balanceChanges || [];
        const status = tx.effects?.status?.status || "unknown";

        // Find recipient and amount from balance changes or transaction inputs
        let to = "Unknown";
        let amountMist = 0;

        if (status === "success") {
          // For successful transactions, get from balance changes
          for (const change of balanceChanges) {
            if (
              change.owner?.AddressOwner &&
              change.owner.AddressOwner.toLowerCase() !== from.toLowerCase()
            ) {
              to = change.owner.AddressOwner;
              amountMist = Math.abs(Number(change.amount || 0));
              break;
            }
          }
        } else {
          // For failed transactions, get intended recipient from transaction inputs
          const inputs = tx.transaction?.data?.transaction?.inputs || [];

          const addressInput = inputs.find(
            (input) => input.type === "pure" && input.valueType === "address"
          );

          // Find the amount input
          const amountInput = inputs.find(
            (input) => input.type === "pure" && input.valueType === "u64"
          );

          if (addressInput) {
            to = addressInput.value;
          }

          if (amountInput) {
            amountMist = parseInt(amountInput.value);
          }

          const gasChange = balanceChanges.find(
            (change) =>
              change.owner?.AddressOwner?.toLowerCase() === from.toLowerCase()
          );
          if (gasChange && !amountMist) {
            amountMist = Math.abs(Number(gasChange.amount || 0));
          }
        }

        const amountSui = (amountMist / 1e9).toFixed(6);
        const datetime = tx.timestampMs
          ? new Date(Number(tx.timestampMs)).toLocaleString()
          : "N/A";
        const timestamp = Number(tx.timestampMs || 0);

        // Determine direction based on address
        const direction =
          from.toLowerCase() === address.toLowerCase() ? "Sent" : "Received";

        // Format status
        const statusText =
          status === "success"
            ? "Confirmed"
            : status === "failure"
            ? "Failed"
            : status.charAt(0).toUpperCase() + status.slice(1);

        // Get error message if failed
        const errorMessage =
          status === "failure"
            ? tx?.effects?.status?.error || "Transaction failed"
            : null;

        return {
          digest: tx.digest,
          from,
          to,
          amountSui,
          datetime,
          timestamp,
          direction,
          status: statusText,
          rawStatus: status,
          errorMessage,
        };
      });

      return {
        txs: transactions,
        hasNextPage,
        nextCursor,
      };
    } catch (e) {
      console.error("Error fetching transaction history:", e);
      return {
        txs: [],
        hasNextPage: false,
        nextCursor: null,
      };
    }
  },

  // SUI Transaction
  async prepareSuiTransaction(privateKey, recipientAddress, amount) {
    const SUI_RPC_URL = "https://fullnode.mainnet.sui.io:443";

    if (!privateKey || !recipientAddress || !amount)
      throw new Error("Missing required parameters.");

    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) throw new Error("Invalid amount specified.");

    //  Get sender's address and private key from any supported format
    const wallet = await suiCrypto.generateMultiChain(privateKey);
    const senderAddress = wallet.SUI.address;
    const suiPrivateKey = wallet.SUI.privateKey;

    //  Get sender coins
    const coinResponse = await fetch(SUI_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "suix_getCoins",
        params: [senderAddress, "0x2::sui::SUI"],
      }),
    });
    const coinJson = await coinResponse.json();
    if (coinJson.error) throw new Error(coinJson.error.message);
    const coins = coinJson.result.data;
    if (!coins.length) throw new Error("No SUI balance found.");

    const amountInMist = Math.floor(amt * 1e9).toString();

    const txResponse = await fetch(SUI_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "unsafe_paySui",
        params: [
          senderAddress,
          [coins[0].coinObjectId],
          [recipientAddress],
          [amountInMist],
          "50000000",
        ],
      }),
    });
    const txJson = await txResponse.json();

    if (txJson.error) throw new Error(`Build failed: ${txJson.error.message}`);
    const txBytes = txJson.result.txBytes;

    //  Simulate for gas estimate
    const dryRunResponse = await fetch(SUI_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sui_dryRunTransactionBlock",
        params: [txBytes],
      }),
    });
    const dryRunJson = await dryRunResponse.json();
    if (dryRunJson.error)
      throw new Error(`Dry run failed: ${dryRunJson.error.message}`);

    const gasUsed = dryRunJson.result.effects.gasUsed;
    const gasFee =
      parseInt(gasUsed.computationCost) +
      parseInt(gasUsed.storageCost) -
      parseInt(gasUsed.storageRebate);

    return {
      senderAddress,
      suiPrivateKey,
      txBytes,
      gasFee: gasFee,
    };
  },

  // Sign and Send SUI Transaction
  async signAndSendSuiTransaction(preparedTx) {
    const SUI_RPC_URL = "https://fullnode.mainnet.sui.io:443";

    // Sign the transaction bytes
    const signature = await suiCrypto.sign(
      preparedTx.txBytes,
      preparedTx.suiPrivateKey
    );

    // Execute the transaction
    const response = await fetch(SUI_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sui_executeTransactionBlock",
        params: [
          preparedTx.txBytes,
          [signature],
          null,
          "WaitForLocalExecution",
        ],
      }),
    });

    const result = await response.json();
    if (result.error) throw new Error(result.error.message);
    return result;
  },

  // Get Transaction Details by Hash
  async getTransactionDetails(transactionHash) {
    const SUI_RPC_URL = "https://fullnode.mainnet.sui.io:443";

    if (!transactionHash) {
      throw new Error("Transaction hash is required");
    }

    try {
      const res = await fetch(SUI_RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sui_getTransactionBlock",
          params: [
            transactionHash,
            {
              showInput: true,
              showEffects: true,
              showEvents: true,
              showBalanceChanges: true,
              showObjectChanges: true,
            },
          ],
        }),
      });

      const json = await res.json();

      if (json.error) {
        throw new Error(json.error.message);
      }

      const txData = json.result;
      if (!txData) {
        throw new Error("Transaction not found");
      }

      // Extract transaction details
      const digest = txData.digest;
      const sender = txData.transaction?.data?.sender || "Unknown";
      const gasUsed = txData.effects?.gasUsed;
      const status = txData.effects?.status?.status || "Unknown";
      const timestamp = txData.timestampMs
        ? new Date(Number(txData.timestampMs)).toLocaleString()
        : "N/A";

      // Extract transfer information
      let recipient = "Unknown";
      let amount = 0;
      let coinType = "0x2::sui::SUI";

      if (status === "success") {
        // For successful transactions, check events first
        for (const event of txData.events || []) {
          if (
            event.type?.includes("TransferEvent") ||
            event.type?.includes("::coin::Transfer")
          ) {
            recipient = event.parsedJson?.recipient || "Unknown";
            amount = Number(event.parsedJson?.amount || 0);
            break;
          }
        }

        // If no transfer event found, check balance changes
        if (recipient === "Unknown" && txData.balanceChanges?.length) {
          const change = txData.balanceChanges.find(
            (c) => c.owner?.AddressOwner && c.owner.AddressOwner !== sender
          );
          if (change) {
            recipient = change.owner.AddressOwner;
            amount = Math.abs(Number(change.amount || 0));
            coinType = change.coinType || coinType;
          }
        }
      } else {
        // For failed transactions, get intended recipient from transaction inputs
        const inputs = txData.transaction?.data?.transaction?.inputs || [];

        // Find the address input 
        const addressInput = inputs.find(
          (input) => input.type === "pure" && input.valueType === "address"
        );

        // Find the amount input
        const amountInput = inputs.find(
          (input) => input.type === "pure" && input.valueType === "u64"
        );

        if (addressInput) {
          recipient = addressInput.value;
        }

        if (amountInput) {
          amount = parseInt(amountInput.value);
        }

        if (!amount && txData.balanceChanges?.length) {
          const gasChange = txData.balanceChanges.find(
            (change) =>
              change.owner?.AddressOwner?.toLowerCase() === sender.toLowerCase()
          );
          if (gasChange) {
            amount = Math.abs(Number(gasChange.amount || 0));
          }
        }
      }

      // Calculate gas fee
      const gasFee = gasUsed
        ? parseInt(gasUsed.computationCost) +
          parseInt(gasUsed.storageCost) -
          parseInt(gasUsed.storageRebate)
        : 0;

      // Format status for display
      const statusText =
        status === "success"
          ? "Confirmed"
          : status === "failure"
          ? "Failed"
          : status === "unknown"
          ? "Unknown"
          : status.charAt(0).toUpperCase() + status.slice(1);

      // Get error message if transaction failed
      const errorMessage =
        status === "failure"
          ? txData?.effects?.status?.error ||
            txData?.effects?.status?.errorMessage ||
            "Transaction failed"
          : null;

      return {
        digest,
        sender,
        recipient,
        amount: (amount / 1e9).toFixed(6), // Convert MIST to SUI
        coinType,
        status: statusText,
        rawStatus: status,
        timestamp,
        gasUsed: (gasFee / 1e9).toFixed(6), // Convert MIST to SUI
        errorMessage,
        rawData: txData,
      };
    } catch (error) {
      console.error("Error fetching transaction details:", error);
      throw error;
    }
  },
};

window.suiBlockchainAPI = suiBlockchainAPI;
