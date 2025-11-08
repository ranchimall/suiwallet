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
  async getTransactionHistory(address, page = 1, limit = 10) {
    const SUI_RPC_URL = "https://fullnode.mainnet.sui.io:443";

    try {
      const requiredTransactions = page * limit;
      const smartBatchSize = requiredTransactions + 20; 
      console.log(
        `Page ${page}: Smart batching - need ${requiredTransactions}, fetching ${smartBatchSize}`
      );

      // Get both sent (FromAddress) and received (ToAddress) transactions
      let allFromDigests = [];
      let allToDigests = [];
      let fromCursor = null;
      let toCursor = null;
      let fromHasMore = true;
      let toHasMore = true;

      // Keep a set of unique digests while fetching.
      const uniqueDigestSet = new Set();
      const digestToTimestamp = new Map(); // Store timestamps from queryTransactionBlocks
      let safetyCounter = 0;
      const MAX_FETCH_ROUNDS = 10;

      while (
        (fromHasMore || toHasMore) &&
        uniqueDigestSet.size < smartBatchSize &&
        safetyCounter < MAX_FETCH_ROUNDS
      ) {
        safetyCounter++;
        const requests = [];

        if (fromHasMore) {
          requests.push(
            fetch(SUI_RPC_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "suix_queryTransactionBlocks",
                params: [
                  {
                    filter: { FromAddress: address },
                    options: { showInput: true, showEffects: true },
                  },
                  fromCursor,
                  Math.min(25, smartBatchSize - allFromDigests.length),
                  true,
                ],
              }),
            })
          );
        }

        // Fetch TO transactions if we still have more
        if (toHasMore) {
          requests.push(
            fetch(SUI_RPC_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "suix_queryTransactionBlocks",
                params: [
                  {
                    filter: { ToAddress: address },
                    options: { showInput: true, showEffects: true },
                  },
                  toCursor,
                  Math.min(25, smartBatchSize - allToDigests.length),
                  true,
                ],
              }),
            })
          );
        }

        const responses = await Promise.all(requests);
        let responseIndex = 0;

        // Process FROM response
        if (fromHasMore && responses[responseIndex]) {
          const fromJson = await responses[responseIndex].json();
          responseIndex++;
          const newFromDigests =
            fromJson.result?.data?.map((d) => d.digest) || [];
          allFromDigests.push(...newFromDigests);

          // Store timestamps from queryTransactionBlocks
          fromJson.result?.data?.forEach((tx) => {
            if (tx.digest && tx.timestampMs) {
              digestToTimestamp.set(tx.digest, Number(tx.timestampMs));
            }
          });

          // Add to unique set
          newFromDigests.forEach((dg) => uniqueDigestSet.add(dg));
          fromCursor = fromJson.result?.nextCursor;
          fromHasMore =
            !!fromJson.result?.hasNextPage && newFromDigests.length > 0;
          console.log(
            `Page ${page}: FROM batch - got ${newFromDigests.length}, total ${allFromDigests.length}, unique ${uniqueDigestSet.size}, hasMore: ${fromHasMore}`
          );
        }

        // Process TO response
        if (toHasMore && responses[responseIndex]) {
          const toJson = await responses[responseIndex].json();
          const newToDigests = toJson.result?.data?.map((d) => d.digest) || [];
          allToDigests.push(...newToDigests);

          // Store timestamps from queryTransactionBlocks
          toJson.result?.data?.forEach((tx) => {
            if (tx.digest && tx.timestampMs) {
              digestToTimestamp.set(tx.digest, Number(tx.timestampMs));
            }
          });

          // Add to unique set
          newToDigests.forEach((dg) => uniqueDigestSet.add(dg));
          toCursor = toJson.result?.nextCursor;
          toHasMore = !!toJson.result?.hasNextPage && newToDigests.length > 0;
          console.log(
            `Page ${page}: TO batch - got ${newToDigests.length}, total ${allToDigests.length}, unique ${uniqueDigestSet.size}, hasMore: ${toHasMore}`
          );
        }

        if (requests.length === 0) break;
      }

      console.log(
        `Page ${page}: Final totals - FROM=${allFromDigests.length}, TO=${allToDigests.length} digests`
      );
      // Use the unique set as the deduplicated result
      const uniqueDigests = [...uniqueDigestSet];

      const mightHaveMorePages = fromHasMore || toHasMore;
      console.log(
        `Page ${page}: HasNextPage - FROM: ${fromHasMore}, TO: ${toHasMore}`
      );

      let digests = uniqueDigests;
      console.log(
        `Page ${page}: Got ${digests.length} unique digests from API`
      );

      const neededForPage = page * limit;

      // Fetch ALL transaction details first, then sort globally by timestamp
      console.log(
        `Page ${page}: Fetching details for ALL ${digests.length} transactions for global time-sort`
      );

      // Convert Set to Array for processing
      const allUniqueDigests = Array.from(uniqueDigestSet);
      const allDetails = [];
      const BATCH_SIZE = 20;

      // Fetch transaction details for ALL unique digests
      for (let i = 0; i < allUniqueDigests.length; i += BATCH_SIZE) {
        const batch = allUniqueDigests.slice(i, i + BATCH_SIZE);
        console.log(
          `Page ${page}: Processing batch ${Math.floor(i / BATCH_SIZE) + 1}: ${
            batch.length
          } transactions`
        );

        try {
          // Use sui_multiGetTransactionBlocks
          const batchRes = await fetch(SUI_RPC_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "sui_multiGetTransactionBlocks",
              params: [
                batch, // Array of digests
                {
                  showInput: true,
                  showRawInput: false,
                  showEffects: true,
                  showEvents: true,
                  showObjectChanges: false,
                  showBalanceChanges: true,
                },
              ],
            }),
          });

          if (!batchRes.ok) {
            console.warn(`HTTP ${batchRes.status} for batch starting at ${i}`);
            continue;
          }

          const batchJson = await batchRes.json();

          if (batchJson.error) {
            console.warn(`Batch API error:`, batchJson.error);
            continue;
          }

          // Filter out null results and add missing timestamps
          const validResults = batchJson.result.filter(Boolean);

          // Ensure every transaction has a timestamp
          validResults.forEach((tx) => {
            if (!tx.timestampMs && digestToTimestamp.has(tx.digest)) {
              tx.timestampMs = digestToTimestamp.get(tx.digest);
            }
          });

          allDetails.push(...validResults);

          console.log(
            `Page ${page}: Batch ${Math.floor(i / BATCH_SIZE) + 1}: Got ${
              validResults.length
            }/${batch.length} valid transactions`
          );
        } catch (error) {
          console.error(`Batch fetch error for batch starting at ${i}:`, error);
        }

        if (i + BATCH_SIZE < allUniqueDigests.length) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      console.log(
        `Page ${page}: Fetched ${allDetails.length} total transaction details`
      );

      allDetails.sort((a, b) => {
        const t1 = Number(a.timestampMs || 0);
        const t2 = Number(b.timestampMs || 0);
        return t2 - t1; // Newest first
      });

      console.log(
        `Page ${page}: Globally sorted ${allDetails.length} transactions by timestamp`
      );

      const startIndex = (page - 1) * limit;
      const endIndex = page * limit;
      const validDetails = allDetails.slice(startIndex, endIndex);

      console.log(
        `Page ${page}: Showing ${validDetails.length} transactions for this page`
      );

      
      if (validDetails.length === 0 && page > 1) {
        console.warn(`Page ${page}: No transactions available for this page`);
        return {
          txs: [],
          hasNextPage: false,
          nextCursor: {
            from: fromCursor,
            to: toCursor,
            fromHasMore,
            toHasMore,
          },
        };
      }

      console.log(
        `Page ${page}: Returning ${validDetails.length} transactions (globally sorted)`
      );

      
      const totalAvailableTransactions = allDetails.length;
      const hasNextPage =
        endIndex < totalAvailableTransactions || mightHaveMorePages;
      console.log(
        `Page ${page}: hasNextPage = ${hasNextPage} (total: ${totalAvailableTransactions}, endIndex: ${endIndex}, mightHaveMorePages: ${mightHaveMorePages})`
      );

      // Transform to the expected format
      const transactions = validDetails.map((tx) => {
        const from = tx.transaction?.data?.sender || "Unknown";
        const balanceChanges = tx.balanceChanges || [];
        const status = tx.effects?.status?.status || "unknown";

        let to = "Unknown";
        let amountRaw = 0;
        let coinType = "0x2::sui::SUI"; // Default to SUI

        let maxChangeAmount = 0;
        for (const change of balanceChanges) {
          const changeAmount = Math.abs(Number(change.amount || 0));
          const changeOwner = change.owner?.AddressOwner;
          const changeCoinType = change.coinType || "0x2::sui::SUI";

          if (
            changeOwner &&
            changeOwner.toLowerCase() !== from.toLowerCase() &&
            changeAmount > maxChangeAmount
          ) {
            to = changeOwner;
            amountRaw = changeAmount;
            coinType = changeCoinType; 
            maxChangeAmount = changeAmount;
          }
        }

        if (to === "Unknown" || amountRaw === 0) {
          const inputs = tx.transaction?.data?.transaction?.inputs || [];

          // Find the address input (recipient)
          const addressInput = inputs.find(
            (input) => input.type === "pure" && input.valueType === "address"
          );

          // Find the amount input
          const amountInput = inputs.find(
            (input) => input.type === "pure" && input.valueType === "u64"
          );

          if (addressInput && to === "Unknown") {
            to = addressInput.value;
          }

          if (amountInput && amountRaw === 0) {
            amountRaw = parseInt(amountInput.value);
          }
        }

        if (amountRaw === 0) {
          const senderChange = balanceChanges.find(
            (change) =>
              change.owner?.AddressOwner?.toLowerCase() === from.toLowerCase()
          );
          if (senderChange) {
            const totalChange = Math.abs(Number(senderChange.amount || 0));
            const gasEstimate = 1500000; 
            if (totalChange > gasEstimate * 2) {
              amountRaw = totalChange - gasEstimate;
            } else if (status !== "success") {
              // For failed transactions
              amountRaw = totalChange;
            }
          }
        }

       
        const datetime = tx.timestampMs
          ? new Date(Number(tx.timestampMs)).toLocaleString()
          : "N/A";
        const timestamp = Number(tx.timestampMs || 0);

        // Determine direction 
        let direction = "Other";

        // Direct check for self-transfer (same from and to address)
        if (
          from.toLowerCase() === address.toLowerCase() &&
          to.toLowerCase() === address.toLowerCase()
        ) {
          direction = "Self";
        } else {
          // Check balance changes to determine if this address gained or lost value
          for (const change of balanceChanges) {
            if (
              change.owner?.AddressOwner?.toLowerCase() ===
              address.toLowerCase()
            ) {
              const changeAmount = Number(change.amount || 0);
              if (changeAmount > 0) {
                direction = "Received";
              } else if (changeAmount < 0) {
                const hasPositiveChange = balanceChanges.some(
                  (c) =>
                    c.owner?.AddressOwner?.toLowerCase() ===
                      address.toLowerCase() && Number(c.amount || 0) > 0
                );
                direction = hasPositiveChange ? "Self" : "Sent";
              }
              break;
            }
          }

          if (direction === "Other") {
            if (from.toLowerCase() === address.toLowerCase()) {
              direction =
                to.toLowerCase() === address.toLowerCase() ? "Self" : "Sent";
            } else if (to.toLowerCase() === address.toLowerCase()) {
              direction = "Received";
            }
          }
        }

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

        
        let decimals = 1e9; 
        let symbol = "SUI";

        if (coinType) {
          if (coinType.includes("usdc") || coinType.includes("USDC")) {
            decimals = 1e6; 
            symbol = "USDC";
          } else if (coinType === "0x2::sui::SUI") {
            decimals = 1e9; 
            symbol = "SUI";
          }
          
        }

        const amountFormatted = (amountRaw / decimals).toFixed(6);

        return {
          digest: tx.digest,
          from,
          to,
          amount: amountFormatted,
          amountRaw,
          coinType: coinType || "0x2::sui::SUI",
          symbol: symbol,
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
        nextCursor: {
          from: fromCursor,
          to: toCursor,
          fromHasMore,
          toHasMore,
        },
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

      // First, try to get recipient and amount from transaction inputs (works for all transactions)
      const inputs = txData.transaction?.data?.transaction?.inputs || [];

      // Find the address input (recipient)
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

      if (status === "success" && (recipient === "Unknown" || amount === 0)) {
        // Check events for transfer information
        for (const event of txData.events || []) {
          if (
            event.type?.includes("TransferEvent") ||
            event.type?.includes("::coin::Transfer")
          ) {
            if (recipient === "Unknown") {
              recipient = event.parsedJson?.recipient || recipient;
            }
            if (amount === 0) {
              amount = Number(event.parsedJson?.amount || 0);
            }
            break;
          }
        }

        // If still no recipient found, check balance changes for different owner
        if (recipient === "Unknown" && txData.balanceChanges?.length) {
          const change = txData.balanceChanges.find(
            (c) => c.owner?.AddressOwner && c.owner.AddressOwner !== sender
          );
          if (change) {
            recipient = change.owner.AddressOwner;
            if (amount === 0) {
              amount = Math.abs(Number(change.amount || 0));
            }
            coinType = change.coinType || coinType;
          }
        }
      }

      // If still no amount, try to get it from balance changes
      if (amount === 0 && txData.balanceChanges?.length) {
        const gasChange = txData.balanceChanges.find(
          (change) =>
            change.owner?.AddressOwner?.toLowerCase() === sender.toLowerCase()
        );
        if (gasChange) {
          const totalChange = Math.abs(Number(gasChange.amount || 0));
          const gasEstimate = 1500000;

          if (totalChange > gasEstimate * 2) {
            amount = totalChange - gasEstimate;
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
