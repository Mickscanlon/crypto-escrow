// src/App.jsx
import React, { useState, useEffect } from "react";
import {
  Shield,
  Plus,
  ArrowRight,
  Check,
  X,
  Loader2,
  LogOut,
  Home,
  Trash2,
  AlertCircle,
  MessageCircle,
} from "lucide-react";
import { auth, db } from "./firebase";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";
import {
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  query,
  where,
  serverTimestamp,
  onSnapshot,
} from "firebase/firestore";

const ESCROW_WALLET = "bc1qsjk265qpnpzndl8439tmelxzgd8qnnwewrkrf7";
const ADMIN_SIGNAL = "@cryptoescrow.01"; // Replace with actual Signal username

export default function CryptoEscrowApp() {
  const [currentPage, setCurrentPage] = useState("auth");
  const [authMode, setAuthMode] = useState("login");
  const [currentUser, setCurrentUser] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [allUsers, setAllUsers] = useState({});
  const [loading, setLoading] = useState(true);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [wallet, setWallet] = useState("");
  const [authError, setAuthError] = useState("");

  const [txForm, setTxForm] = useState({
    role: "seller",
    amount: "",
    currency: "BTC",
    terms: "",
    inviteEmail: "",
  });

  const [selectedTx, setSelectedTx] = useState(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        setCurrentUser(user);
        const userDoc = await getDoc(doc(db, "users", user.uid));
        if (userDoc.exists()) {
          const userData = userDoc.data();
          setUserProfile(userData);
          // Admin goes straight to admin panel
          if (userData.isAdmin) {
            setCurrentPage("admin");
          } else {
            setCurrentPage("dashboard");
          }
        }
      } else {
        setCurrentUser(null);
        setUserProfile(null);
        setCurrentPage("auth");
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const loadUsers = async () => {
      const usersSnap = await getDocs(collection(db, "users"));
      const usersMap = {};
      usersSnap.forEach((doc) => {
        usersMap[doc.id] = doc.data();
      });
      setAllUsers(usersMap);
    };
    loadUsers();
  }, []);

  useEffect(() => {
    if (!currentUser) return;

    // If admin, fetch all transactions. Otherwise, fetch only user's transactions
    let q;
    if (userProfile?.isAdmin) {
      q = query(collection(db, "transactions"));
    } else {
      q = query(
        collection(db, "transactions"),
        where("participants", "array-contains", currentUser.uid)
      );
    }

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const txs = [];
      snapshot.forEach((doc) => {
        txs.push({ id: doc.id, ...doc.data() });
      });
      setTransactions(txs.sort((a, b) => b.createdAt - a.createdAt));
    });
    return () => unsubscribe();
  }, [currentUser, userProfile]);

  const handleAuth = async (e) => {
    e.preventDefault();
    setAuthError("");
    setLoading(true);

    try {
      if (authMode === "signup") {
        if (!email || !password || !username || !wallet) {
          setAuthError("All fields required");
          setLoading(false);
          return;
        }
        const userCredential = await createUserWithEmailAndPassword(
          auth,
          email,
          password
        );
        await setDoc(doc(db, "users", userCredential.user.uid), {
          email,
          username,
          wallet,
          createdAt: serverTimestamp(),
          isAdmin: email === "admin@escrow.com",
        });
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (error) {
      // User-friendly error messages
      if (
        error.code === "auth/invalid-credential" ||
        error.code === "auth/user-not-found" ||
        error.code === "auth/wrong-password"
      ) {
        setAuthError("Invalid email or password. Please try again.");
      } else if (error.code === "auth/email-already-in-use") {
        setAuthError("This email is already registered. Please login instead.");
      } else if (error.code === "auth/weak-password") {
        setAuthError("Password should be at least 6 characters.");
      } else if (error.code === "auth/invalid-email") {
        setAuthError("Please enter a valid email address.");
      } else {
        setAuthError("An error occurred. Please try again.");
      }
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
  };

  const createTransaction = async (e) => {
    e.preventDefault();

    try {
      const invitedUserEntry = Object.entries(allUsers).find(
        ([_, u]) => u.email === txForm.inviteEmail
      );
      if (!invitedUserEntry) {
        alert("Invited user not found");
        return;
      }
      const [invitedUid, invitedUser] = invitedUserEntry;

      if (invitedUid === currentUser.uid) {
        alert("Cannot invite yourself");
        return;
      }

      const txId = "TX" + Date.now();
      const txData = {
        creator: currentUser.uid,
        creatorRole: txForm.role,
        invited: invitedUid,
        invitedRole: txForm.role === "seller" ? "buyer" : "seller",
        amount: parseFloat(txForm.amount),
        currency: txForm.currency,
        terms: txForm.terms,
        status: "pending_acceptance",
        escrowWallet: ESCROW_WALLET,
        sellerWallet: txForm.role === "seller" ? userProfile.wallet : "",
        buyerWallet: txForm.role === "buyer" ? userProfile.wallet : "",
        createdAt: Date.now(),
        participants: [currentUser.uid, invitedUid],
        paymentSent: false,
        paymentReceived: false,
        goodsReleased: false,
        buyerApproved: false,
        completed: false,
      };

      await setDoc(doc(db, "transactions", txId), txData);

      setTxForm({
        role: "seller",
        amount: "",
        currency: "BTC",
        terms: "",
        inviteEmail: "",
      });

      setCurrentPage("dashboard");
    } catch (error) {
      alert("Error creating transaction: " + error.message);
    }
  };

  const acceptTransaction = async (txId) => {
    const txRef = doc(db, "transactions", txId);
    const txSnap = await getDoc(txRef);
    const tx = txSnap.data();

    await updateDoc(txRef, {
      status: "waiting_payment",
      sellerWallet:
        tx.invitedRole === "seller" ? userProfile.wallet : tx.sellerWallet,
      buyerWallet:
        tx.invitedRole === "buyer" ? userProfile.wallet : tx.buyerWallet,
    });
  };

  const markPaymentSent = async (txId) => {
    await updateDoc(doc(db, "transactions", txId), {
      paymentSent: true,
      status: "awaiting_confirmation",
    });
  };

  const markPaymentReceived = async (txId) => {
    await updateDoc(doc(db, "transactions", txId), {
      paymentReceived: true,
      status: "payment_received",
    });
  };

  const markGoodsReleased = async (txId) => {
    await updateDoc(doc(db, "transactions", txId), {
      goodsReleased: true,
      status: "goods_released",
    });
  };

  const approveFunds = async (txId) => {
    await updateDoc(doc(db, "transactions", txId), {
      buyerApproved: true,
      completed: true,
      status: "completed",
    });
  };

  const rejectTransaction = async (txId) => {
    await updateDoc(doc(db, "transactions", txId), {
      status: "rejected",
    });
  };

  const deleteTransaction = async (txId) => {
    if (
      window.confirm(
        "Are you sure you want to delete this transaction? This action cannot be undone."
      )
    ) {
      try {
        await deleteDoc(doc(db, "transactions", txId));
        if (currentPage === "details") {
          setCurrentPage("dashboard");
        }
      } catch (error) {
        alert("Error deleting transaction: " + error.message);
      }
    }
  };

  const canDeleteTransaction = (tx) => {
    // Can delete if: rejected, pending_acceptance, waiting_payment, or awaiting_confirmation
    const deletableStatuses = [
      "rejected",
      "pending_acceptance",
      "waiting_payment",
      "awaiting_confirmation",
    ];
    return deletableStatuses.includes(tx.status);
  };

  const isAdmin = userProfile?.isAdmin || false;

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Loader2 className="w-12 h-12 text-indigo-600 animate-spin" />
      </div>
    );
  }

  // Auth Page
  if (!currentUser || currentPage === "auth") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md">
          <div className="flex items-center justify-center mb-8">
            <Shield className="w-12 h-12 text-indigo-600 mr-3" />
            <h1 className="text-3xl font-bold text-gray-800">CryptoEscrow</h1>
          </div>

          <div className="flex gap-2 mb-6">
            <button
              onClick={() => setAuthMode("login")}
              className={`flex-1 py-2 rounded-lg font-medium transition ${
                authMode === "login"
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-100 text-gray-600"
              }`}
            >
              Login
            </button>
            <button
              onClick={() => setAuthMode("signup")}
              className={`flex-1 py-2 rounded-lg font-medium transition ${
                authMode === "signup"
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-100 text-gray-600"
              }`}
            >
              Sign Up
            </button>
          </div>

          <form onSubmit={handleAuth} className="space-y-4">
            {authMode === "signup" && (
              <>
                <input
                  type="text"
                  placeholder="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                />
                <input
                  type="text"
                  placeholder="Your BTC Wallet Address"
                  value={wallet}
                  onChange={(e) => setWallet(e.target.value)}
                  className="w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                />
              </>
            )}

            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
            />

            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
            />

            {authError && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
                {authError}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-indigo-600 text-white py-3 rounded-lg font-semibold hover:bg-indigo-700 transition disabled:opacity-50"
            >
              {loading
                ? "Loading..."
                : authMode === "login"
                ? "Login"
                : "Create Account"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const Navigation = () => (
    <nav className="bg-white border-b border-gray-200 px-6 py-4">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-6">
          <div className="flex items-center">
            <Shield className="w-8 h-8 text-indigo-600 mr-2" />
            <span className="text-xl font-bold text-gray-800">
              CryptoEscrow
            </span>
          </div>

          <div className="flex gap-4">
            {!isAdmin && (
              <>
                <button
                  onClick={() => setCurrentPage("dashboard")}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg transition ${
                    currentPage === "dashboard"
                      ? "bg-indigo-100 text-indigo-700"
                      : "text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  <Home className="w-4 h-4" />
                  Dashboard
                </button>

                <button
                  onClick={() => setCurrentPage("create")}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg transition ${
                    currentPage === "create"
                      ? "bg-indigo-100 text-indigo-700"
                      : "text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  <Plus className="w-4 h-4" />
                  New Transaction
                </button>
              </>
            )}

            {isAdmin && (
              <button
                onClick={() => setCurrentPage("admin")}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg transition ${
                  currentPage === "admin"
                    ? "bg-indigo-100 text-indigo-700"
                    : "text-gray-600 hover:bg-gray-100"
                }`}
              >
                <Shield className="w-4 h-4" />
                Admin Panel
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-right">
            <p className="text-sm font-medium text-gray-800">
              {userProfile?.username}
            </p>
            <p className="text-xs text-gray-500">{userProfile?.email}</p>
          </div>
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition"
          >
            <LogOut className="w-4 h-4" />
            Logout
          </button>
        </div>
      </div>
    </nav>
  );

  // Dashboard
  if (currentPage === "dashboard") {
    return (
      <div className="min-h-screen bg-gray-50">
        <Navigation />

        <div className="max-w-7xl mx-auto p-6">
          <div className="mb-8">
            <h2 className="text-3xl font-bold text-gray-800 mb-2">
              My Transactions
            </h2>
            <p className="text-gray-600">Manage your escrow transactions</p>
          </div>

          {transactions.length === 0 ? (
            <div className="bg-white rounded-xl shadow-sm p-12 text-center">
              <h3 className="text-xl font-semibold text-gray-700 mb-2">
                No transactions yet
              </h3>
              <p className="text-gray-500 mb-6">
                Create your first escrow transaction
              </p>
              <button
                onClick={() => setCurrentPage("create")}
                className="bg-indigo-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-indigo-700 transition"
              >
                Create Transaction
              </button>
            </div>
          ) : (
            <div className="grid gap-6">
              {transactions.map((tx) => {
                const isCreator = tx.creator === currentUser.uid;
                const userRole = isCreator ? tx.creatorRole : tx.invitedRole;
                const otherPartyUid = isCreator ? tx.invited : tx.creator;
                const otherParty =
                  allUsers[otherPartyUid]?.username || "Unknown";

                return (
                  <div
                    key={tx.id}
                    className="bg-white rounded-xl shadow-sm p-6 hover:shadow-md transition"
                  >
                    <div className="flex items-start justify-between mb-4">
                      <div>
                        <div className="flex items-center gap-3 mb-2">
                          <span className="text-lg font-bold text-gray-800">
                            {tx.id}
                          </span>
                          <span
                            className={`px-3 py-1 rounded-full text-xs font-medium ${
                              tx.status === "completed"
                                ? "bg-green-100 text-green-700"
                                : tx.status === "rejected"
                                ? "bg-red-100 text-red-700"
                                : tx.status === "pending_acceptance"
                                ? "bg-yellow-100 text-yellow-700"
                                : "bg-blue-100 text-blue-700"
                            }`}
                          >
                            {tx.status.replace(/_/g, " ").toUpperCase()}
                          </span>
                        </div>
                        <p className="text-gray-600">
                          Role:{" "}
                          <span className="font-medium capitalize">
                            {userRole}
                          </span>{" "}
                          | Other Party:{" "}
                          <span className="font-medium">{otherParty}</span>
                        </p>
                      </div>

                      <p className="text-2xl font-bold text-indigo-600">
                        {tx.amount} {tx.currency}
                      </p>
                    </div>

                    <div className="flex gap-3">
                      <button
                        onClick={() => {
                          setSelectedTx(tx);
                          setCurrentPage("details");
                        }}
                        className="flex-1 bg-indigo-600 text-white py-3 rounded-lg font-medium hover:bg-indigo-700 transition flex items-center justify-center gap-2"
                      >
                        View Details
                        <ArrowRight className="w-4 h-4" />
                      </button>

                      {canDeleteTransaction(tx) && (
                        <button
                          onClick={() => deleteTransaction(tx.id)}
                          className="bg-red-100 text-red-700 px-4 py-3 rounded-lg font-medium hover:bg-red-200 transition flex items-center justify-center gap-2"
                          title="Delete transaction"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Create Transaction
  if (currentPage === "create") {
    return (
      <div className="min-h-screen bg-gray-50">
        <Navigation />

        <div className="max-w-3xl mx-auto p-6">
          <div className="bg-white rounded-xl shadow-sm p-8">
            <h2 className="text-3xl font-bold text-gray-800 mb-6">
              Create New Transaction
            </h2>

            {/* Important Notice */}
            <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 mb-6">
              <div className="flex">
                <AlertCircle className="w-5 h-5 text-yellow-400 mr-3 flex-shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-sm font-semibold text-yellow-800 mb-1">
                    Important: Be Specific in Transaction Terms
                  </h3>
                  <p className="text-sm text-yellow-700">
                    Clearly outline all details of what is being bought/sold in
                    the "Terms" section below. This is crucial for dispute
                    resolution. Agreements made on other platforms (Discord,
                    Telegram, etc.) can be manipulated or edited. Only what is
                    written here will be considered by the admin team if
                    disputes arise.
                  </p>
                </div>
              </div>
            </div>

            <form onSubmit={createTransaction} className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Your Role
                </label>
                <div className="grid grid-cols-2 gap-4">
                  <button
                    type="button"
                    onClick={() => setTxForm({ ...txForm, role: "seller" })}
                    className={`p-4 rounded-lg border-2 transition ${
                      txForm.role === "seller"
                        ? "border-indigo-600 bg-indigo-50"
                        : "border-gray-200"
                    }`}
                  >
                    <p className="font-semibold text-gray-800">Seller</p>
                    <p className="text-sm text-gray-600">You're selling</p>
                  </button>

                  <button
                    type="button"
                    onClick={() => setTxForm({ ...txForm, role: "buyer" })}
                    className={`p-4 rounded-lg border-2 transition ${
                      txForm.role === "buyer"
                        ? "border-indigo-600 bg-indigo-50"
                        : "border-gray-200"
                    }`}
                  >
                    <p className="font-semibold text-gray-800">Buyer</p>
                    <p className="text-sm text-gray-600">You're buying</p>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Amount
                  </label>
                  <input
                    type="number"
                    step="0.00000001"
                    required
                    placeholder="Amount in BTC"
                    value={txForm.amount}
                    onChange={(e) =>
                      setTxForm({ ...txForm, amount: e.target.value })
                    }
                    className="w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Enter the exact BTC amount (not dollar value)
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Currency
                  </label>
                  <select
                    value={txForm.currency}
                    onChange={(e) =>
                      setTxForm({ ...txForm, currency: e.target.value })
                    }
                    className="w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none bg-white"
                    disabled
                  >
                    <option value="BTC">BTC</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Transaction Terms
                </label>
                <textarea
                  required
                  rows={6}
                  value={txForm.terms}
                  onChange={(e) =>
                    setTxForm({ ...txForm, terms: e.target.value })
                  }
                  placeholder="Be specific! Include:
• What exactly is being bought/sold
• Condition of item(s)
• Delivery method and timeline
• Any warranties or guarantees
• Return/refund policy
• Any other important details

Example: 'Selling 1x iPhone 15 Pro, 256GB, Blue, Factory Unlocked, Brand New Sealed. Will ship via FedEx 2-Day within 24 hours of payment confirmation. Tracking number will be provided. 30-day money-back guarantee if item is not as described.'"
                  className="w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Invite {txForm.role === "seller" ? "Buyer" : "Seller"} (Email)
                </label>
                <input
                  type="email"
                  required
                  value={txForm.inviteEmail}
                  onChange={(e) =>
                    setTxForm({ ...txForm, inviteEmail: e.target.value })
                  }
                  placeholder="other@example.com"
                  className="w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                />
              </div>

              <div className="flex gap-4">
                <button
                  type="button"
                  onClick={() => setCurrentPage("dashboard")}
                  className="flex-1 bg-gray-200 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-300 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 bg-indigo-600 text-white py-3 rounded-lg font-medium hover:bg-indigo-700 transition"
                >
                  Create Transaction
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // Transaction Details
  if (currentPage === "details" && selectedTx) {
    const tx = transactions.find((t) => t.id === selectedTx.id) || selectedTx;
    const isCreator = tx.creator === currentUser.uid;
    const userRole = isCreator ? tx.creatorRole : tx.invitedRole;
    const isSeller = userRole === "seller";
    const isBuyer = userRole === "buyer";
    const sellerUid = tx.creatorRole === "seller" ? tx.creator : tx.invited;
    const buyerUid = tx.creatorRole === "buyer" ? tx.creator : tx.invited;

    return (
      <div className="min-h-screen bg-gray-50">
        <Navigation />

        <div className="max-w-4xl mx-auto p-6">
          <button
            onClick={() => setCurrentPage("dashboard")}
            className="mb-6 text-indigo-600 hover:text-indigo-700"
          >
            ← Back
          </button>

          <div className="bg-white rounded-xl shadow-sm p-8">
            <div className="flex items-start justify-between mb-8">
              <div>
                <h2 className="text-3xl font-bold text-gray-800 mb-2">
                  {tx.id}
                </h2>
                <p className="text-gray-600">
                  Role:{" "}
                  <span className="font-medium capitalize">{userRole}</span>
                </p>
              </div>

              <div className="flex items-center gap-3">
                <span
                  className={`px-4 py-2 rounded-full text-sm font-medium ${
                    tx.status === "completed"
                      ? "bg-green-100 text-green-700"
                      : tx.status === "rejected"
                      ? "bg-red-100 text-red-700"
                      : tx.status === "pending_acceptance"
                      ? "bg-yellow-100 text-yellow-700"
                      : "bg-blue-100 text-blue-700"
                  }`}
                >
                  {tx.status.replace(/_/g, " ").toUpperCase()}
                </span>

                {canDeleteTransaction(tx) && (
                  <button
                    onClick={() => deleteTransaction(tx.id)}
                    className="bg-red-100 text-red-700 px-3 py-2 rounded-lg font-medium hover:bg-red-200 transition flex items-center gap-2"
                    title="Delete transaction"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            {/* Contact Admin */}
            <div className="bg-blue-50 border-l-4 border-blue-400 p-4 mb-6">
              <div className="flex">
                <MessageCircle className="w-5 h-5 text-blue-400 mr-3 flex-shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-sm font-semibold text-blue-800 mb-1">
                    Need Help or Have a Dispute?
                  </h3>
                  <p className="text-sm text-blue-700 mb-2">
                    <strong>
                      First, try to resolve any issues directly with the other
                      party.
                    </strong>{" "}
                    If you cannot reach an agreement and need admin assistance,
                    contact us on Signal.
                  </p>
                  <p className="text-sm font-mono text-blue-900 bg-white px-3 py-2 rounded inline-block">
                    Signal: {ADMIN_SIGNAL}
                  </p>
                  <p className="text-xs text-blue-600 mt-2">
                    <strong>For disputes:</strong> Provide clear proof that
                    supports your claim. Screenshots, tracking numbers, photos,
                    and the transaction terms listed below are what the admin
                    will review.
                  </p>
                </div>
              </div>
            </div>

            <div className="grid md:grid-cols-2 gap-6 mb-8">
              <div className="bg-gray-50 rounded-lg p-6">
                <h3 className="font-semibold text-gray-800 mb-4">Details</h3>
                <div className="space-y-3">
                  <div>
                    <p className="text-sm text-gray-600">Amount</p>
                    <p className="text-2xl font-bold text-indigo-600">
                      {tx.amount} {tx.currency}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-600">Seller</p>
                    <p className="font-medium">
                      {allUsers[sellerUid]?.username}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-600">Buyer</p>
                    <p className="font-medium">
                      {allUsers[buyerUid]?.username}
                    </p>
                  </div>
                </div>
              </div>

              <div className="bg-gray-50 rounded-lg p-6">
                <h3 className="font-semibold text-gray-800 mb-4">Wallets</h3>
                <div className="space-y-3">
                  <div>
                    <p className="text-sm text-gray-600">Escrow</p>
                    <p className="font-mono text-xs break-all">
                      {tx.escrowWallet}
                    </p>
                  </div>
                  {tx.sellerWallet && (
                    <div>
                      <p className="text-sm text-gray-600">Seller</p>
                      <p className="font-mono text-xs break-all">
                        {tx.sellerWallet}
                      </p>
                    </div>
                  )}
                  {tx.buyerWallet && (
                    <div>
                      <p className="text-sm text-gray-600">Buyer</p>
                      <p className="font-mono text-xs break-all">
                        {tx.buyerWallet}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="bg-gray-50 rounded-lg p-6 mb-8">
              <h3 className="font-semibold text-gray-800 mb-3">
                Transaction Terms
              </h3>
              <p className="text-gray-700 whitespace-pre-wrap">{tx.terms}</p>
            </div>

            <div className="mb-8">
              <h3 className="font-semibold text-gray-800 mb-4">Progress</h3>
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center ${
                      tx.status !== "pending_acceptance"
                        ? "bg-green-500"
                        : "bg-gray-300"
                    }`}
                  >
                    <Check className="w-5 h-5 text-white" />
                  </div>
                  <p className="text-gray-700">Transaction Accepted</p>
                </div>

                <div className="flex items-center gap-3">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center ${
                      tx.paymentSent ? "bg-green-500" : "bg-gray-300"
                    }`}
                  >
                    {tx.paymentSent ? (
                      <Check className="w-5 h-5 text-white" />
                    ) : (
                      <Loader2 className="w-5 h-5 text-white" />
                    )}
                  </div>
                  <p className="text-gray-700">Seller Marked Payment Sent</p>
                </div>

                <div className="flex items-center gap-3">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center ${
                      tx.paymentReceived ? "bg-green-500" : "bg-gray-300"
                    }`}
                  >
                    {tx.paymentReceived ? (
                      <Check className="w-5 h-5 text-white" />
                    ) : (
                      <Loader2 className="w-5 h-5 text-white" />
                    )}
                  </div>
                  <p className="text-gray-700">
                    Admin Confirmed Payment in Escrow
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center ${
                      tx.goodsReleased ? "bg-green-500" : "bg-gray-300"
                    }`}
                  >
                    {tx.goodsReleased ? (
                      <Check className="w-5 h-5 text-white" />
                    ) : (
                      <Loader2 className="w-5 h-5 text-white" />
                    )}
                  </div>
                  <p className="text-gray-700">
                    Seller Released Goods/Services
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center ${
                      tx.completed ? "bg-green-500" : "bg-gray-300"
                    }`}
                  >
                    {tx.completed ? (
                      <Check className="w-5 h-5 text-white" />
                    ) : (
                      <Loader2 className="w-5 h-5 text-white" />
                    )}
                  </div>
                  <p className="text-gray-700">
                    Buyer Approved & Funds Released
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              {tx.status === "pending_acceptance" && !isCreator && (
                <div className="flex gap-4">
                  <button
                    onClick={() => acceptTransaction(tx.id)}
                    className="flex-1 bg-green-600 text-white py-3 rounded-lg font-medium hover:bg-green-700 transition flex items-center justify-center gap-2"
                  >
                    <Check className="w-5 h-5" />
                    Accept Transaction
                  </button>
                  <button
                    onClick={() => rejectTransaction(tx.id)}
                    className="flex-1 bg-red-600 text-white py-3 rounded-lg font-medium hover:bg-red-700 transition flex items-center justify-center gap-2"
                  >
                    <X className="w-5 h-5" />
                    Reject
                  </button>
                </div>
              )}

              {tx.status === "pending_acceptance" && isCreator && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6">
                  <p className="font-semibold text-yellow-800 mb-2">
                    ⏳ Awaiting Response
                  </p>
                  <p className="text-yellow-700">
                    Waiting for the other party to accept or reject this
                    transaction.
                  </p>
                </div>
              )}

              {tx.status === "waiting_payment" &&
                isSeller &&
                !tx.paymentSent && (
                  <div className="space-y-4">
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
                      <p className="font-semibold text-blue-800 mb-2">
                        💰 Send Payment to Escrow
                      </p>
                      <p className="text-blue-700 mb-3">
                        Send <strong>{tx.amount} BTC</strong> to the escrow
                        wallet address shown above.
                      </p>
                      <p className="text-blue-600 text-sm">
                        Once you've sent the payment, mark it as sent below. The
                        admin will then verify the transaction on the blockchain
                        and confirm receipt.
                      </p>
                    </div>
                    <button
                      onClick={() => markPaymentSent(tx.id)}
                      className="w-full bg-indigo-600 text-white py-3 rounded-lg font-medium hover:bg-indigo-700 transition"
                    >
                      I've Sent the Payment to Escrow
                    </button>
                  </div>
                )}

              {tx.status === "waiting_payment" &&
                isBuyer &&
                !tx.paymentSent && (
                  <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6">
                    <p className="font-semibold text-yellow-800 mb-2">
                      ⏳ Waiting for Seller Payment
                    </p>
                    <p className="text-yellow-700">
                      Waiting for the seller to send payment to the escrow
                      wallet.
                    </p>
                  </div>
                )}

              {(tx.status === "awaiting_confirmation" ||
                (tx.paymentSent && !tx.paymentReceived)) && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6">
                  <p className="font-semibold text-yellow-800 mb-2">
                    ⏳ Awaiting Admin Confirmation
                  </p>
                  <p className="text-yellow-700">
                    {isSeller && "You've marked the payment as sent. "}
                    The admin is verifying the payment on the blockchain. This
                    usually takes a few minutes to a few hours.
                  </p>
                </div>
              )}

              {tx.status === "payment_received" &&
                isSeller &&
                !tx.goodsReleased && (
                  <div className="space-y-4">
                    <div className="bg-green-50 border border-green-200 rounded-lg p-6">
                      <p className="font-semibold text-green-800 mb-2">
                        ✅ Payment Confirmed in Escrow!
                      </p>
                      <p className="text-green-700">
                        The admin has confirmed your payment is in escrow. Now
                        release the goods/services to the buyer.
                      </p>
                    </div>
                    <button
                      onClick={() => markGoodsReleased(tx.id)}
                      className="w-full bg-indigo-600 text-white py-3 rounded-lg font-medium hover:bg-indigo-700 transition"
                    >
                      Confirm Goods/Services Released
                    </button>
                  </div>
                )}

              {tx.status === "payment_received" &&
                isBuyer &&
                !tx.goodsReleased && (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
                    <p className="font-semibold text-blue-800 mb-2">
                      💰 Payment Confirmed
                    </p>
                    <p className="text-blue-700">
                      The payment is secured in escrow. Waiting for the seller
                      to release the goods/services.
                    </p>
                  </div>
                )}

              {tx.status === "goods_released" &&
                isBuyer &&
                !tx.buyerApproved && (
                  <div className="space-y-4">
                    <div className="bg-green-50 border border-green-200 rounded-lg p-6">
                      <p className="font-semibold text-green-800 mb-2">
                        📦 Goods/Services Released!
                      </p>
                      <p className="text-green-700 mb-3">
                        The seller has released the goods/services. Please
                        inspect everything carefully.
                      </p>
                      <p className="text-green-600 text-sm">
                        If everything is as described in the terms above,
                        approve the transaction to release funds to the seller.
                        If there's an issue, contact the seller first to try to
                        resolve it. If that fails, contact the admin on Signal.
                      </p>
                    </div>
                    <button
                      onClick={() => approveFunds(tx.id)}
                      className="w-full bg-green-600 text-white py-3 rounded-lg font-medium hover:bg-green-700 transition"
                    >
                      ✓ Everything is Good - Release Funds to Seller
                    </button>
                  </div>
                )}

              {tx.status === "goods_released" &&
                isSeller &&
                !tx.buyerApproved && (
                  <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6">
                    <p className="font-semibold text-yellow-800 mb-2">
                      ⏳ Awaiting Buyer Approval
                    </p>
                    <p className="text-yellow-700">
                      Waiting for the buyer to inspect and approve. Once
                      approved, the escrowed funds will be released to your
                      wallet.
                    </p>
                  </div>
                )}

              {tx.completed && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-6">
                  <p className="font-semibold text-green-800 mb-2">
                    🎉 Transaction Complete!
                  </p>
                  <p className="text-green-700">
                    {isSeller &&
                      `The funds have been released to your wallet: ${tx.sellerWallet}`}
                    {isBuyer &&
                      `Transaction completed successfully. Thank you for using CryptoEscrow!`}
                  </p>
                </div>
              )}

              {tx.status === "rejected" && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-6">
                  <p className="font-semibold text-red-800 mb-2">
                    ❌ Transaction Rejected
                  </p>
                  <p className="text-red-700">
                    This transaction was rejected and will not proceed. No funds
                    were exchanged.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Admin Panel
  if (currentPage === "admin" && isAdmin) {
    const allTxs = transactions.sort((a, b) => b.createdAt - a.createdAt);

    return (
      <div className="min-h-screen bg-gray-50">
        <Navigation />

        <div className="max-w-7xl mx-auto p-6">
          <div className="mb-8">
            <h2 className="text-3xl font-bold text-gray-800 mb-2">
              Admin Panel
            </h2>
            <p className="text-gray-600">
              Confirm escrow payments on blockchain
            </p>
          </div>

          <div className="grid gap-6">
            {allTxs.map((tx) => {
              const sellerUid =
                tx.creatorRole === "seller" ? tx.creator : tx.invited;
              const buyerUid =
                tx.creatorRole === "buyer" ? tx.creator : tx.invited;

              return (
                <div key={tx.id} className="bg-white rounded-xl shadow-sm p-6">
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <h3 className="text-xl font-bold text-gray-800 mb-2">
                        {tx.id}
                      </h3>
                      <div className="space-y-1 text-sm">
                        <p className="text-gray-600">
                          Seller:{" "}
                          <span className="font-medium">
                            {allUsers[sellerUid]?.username}
                          </span>
                        </p>
                        <p className="text-gray-600">
                          Buyer:{" "}
                          <span className="font-medium">
                            {allUsers[buyerUid]?.username}
                          </span>
                        </p>
                        <p className="text-gray-600">
                          Amount:{" "}
                          <span className="font-medium">
                            {tx.amount} {tx.currency}
                          </span>
                        </p>
                        <p className="text-gray-600">
                          Escrow Wallet:{" "}
                          <span className="font-mono text-xs">
                            {tx.escrowWallet}
                          </span>
                        </p>
                      </div>
                    </div>

                    <span
                      className={`px-3 py-1 rounded-full text-xs font-medium ${
                        tx.status === "completed"
                          ? "bg-green-100 text-green-700"
                          : tx.status === "rejected"
                          ? "bg-red-100 text-red-700"
                          : tx.status === "pending_acceptance"
                          ? "bg-yellow-100 text-yellow-700"
                          : "bg-blue-100 text-blue-700"
                      }`}
                    >
                      {tx.status.replace(/_/g, " ").toUpperCase()}
                    </span>
                  </div>

                  <div className="bg-gray-50 rounded-lg p-4 mb-4">
                    <p className="text-sm font-medium text-gray-700 mb-1">
                      Terms:
                    </p>
                    <p className="text-sm text-gray-600 whitespace-pre-wrap">
                      {tx.terms}
                    </p>
                  </div>

                  {tx.paymentSent && !tx.paymentReceived && (
                    <div className="mt-4">
                      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-3">
                        <p className="text-sm text-yellow-800">
                          ⚠️ Seller marked payment as sent. Verify {tx.amount}{" "}
                          BTC has been received at escrow wallet.
                        </p>
                      </div>
                      <button
                        onClick={() => markPaymentReceived(tx.id)}
                        className="bg-green-600 text-white px-6 py-2 rounded-lg font-medium hover:bg-green-700 transition"
                      >
                        ✓ Confirm Payment Received in Escrow
                      </button>
                    </div>
                  )}

                  {tx.paymentReceived && (
                    <div className="mt-4 bg-green-50 border border-green-200 rounded-lg p-3">
                      <p className="text-sm text-green-700">
                        ✓ Payment confirmed in escrow
                      </p>
                    </div>
                  )}

                  {tx.status === "waiting_payment" && !tx.paymentSent && (
                    <div className="mt-4 bg-gray-50 border border-gray-200 rounded-lg p-3">
                      <p className="text-sm text-gray-600">
                        Waiting for seller to send payment to escrow...
                      </p>
                    </div>
                  )}
                </div>
              );
            })}

            {allTxs.length === 0 && (
              <div className="bg-white rounded-xl shadow-sm p-12 text-center">
                <p className="text-gray-500">No transactions to manage</p>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
}
