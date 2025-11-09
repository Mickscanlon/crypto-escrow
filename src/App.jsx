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
  Search,
} from "lucide-react";
import { auth, db } from "./firebase";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  reauthenticateWithCredential,
  EmailAuthProvider,
  updatePassword,
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
  addDoc,
  orderBy,
} from "firebase/firestore";

/**
 * Full-feature App.jsx implementing:
 * - In-app notifications (Firestore)
 * - Multi-currency: BTC, BCH, ETH
 * - Audit trail per-transaction (transactions/{txId}/audit) — admin only viewing
 * - UI improvements: search, filter, pagination, progress bar
 * - Profile editing: username, wallet, password (reauth required)
 * - Dispute statuses: under_review, refunded (admin controls)
 *
 * Notes:
 * - We purposely did NOT include blockchain verification mock (per request).
 * - Messaging between users is intentionally omitted.
 */

/* === Config / Constants === */
const ESCROW_WALLET = "bc1qsjk265qpnpzndl8439tmelxzgd8qnnwewrkrf7";
const ADMIN_SIGNAL = "@cryptoescrow.01";
const DEFAULT_ITEMS_PER_PAGE = 8;

// Status => progress percentage (for progress bar)
const STATUS_PROGRESS = {
  pending_acceptance: 10,
  waiting_payment: 30,
  awaiting_confirmation: 50,
  payment_received: 70,
  goods_released: 85,
  completed: 100,
  rejected: 0,
  under_review: 40,
  refunded: 0,
};

export default function CryptoEscrowApp() {
  /* === Auth / Global state === */
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

  /* === New features state === */
  // Notifications (in-app)
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);

  // Search / filter / pagination UI
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(DEFAULT_ITEMS_PER_PAGE);

  // Admin audit modal
  const [auditModal, setAuditModal] = useState({
    open: false,
    txId: null,
    logs: [],
  });

  // Profile edit fields
  const [editUsername, setEditUsername] = useState("");
  const [editWallet, setEditWallet] = useState("");
  const [currentPasswordForReauth, setCurrentPasswordForReauth] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [profileMessage, setProfileMessage] = useState("");

  /* === Effects: auth listener, load users, load transactions, load notifications === */
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setLoading(true);
      if (user) {
        setCurrentUser(user);
        const userDoc = await getDoc(doc(db, "users", user.uid));
        if (userDoc.exists()) {
          const userData = userDoc.data();
          setUserProfile(userData);
          // navigate
          if (userData.isAdmin) {
            setCurrentPage("admin");
          } else {
            setCurrentPage("dashboard");
          }
        } else {
          // new user but no doc (shouldn't happen) — send to auth
          setCurrentPage("auth");
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

  // Load all users map (for lookups)
  useEffect(() => {
    const loadUsers = async () => {
      const usersSnap = await getDocs(collection(db, "users"));
      const usersMap = {};
      usersSnap.forEach((d) => {
        usersMap[d.id] = d.data();
      });
      setAllUsers(usersMap);
    };
    loadUsers();
  }, []);

  // Subscribe to transactions (admin gets all, normal user gets their own)
  useEffect(() => {
    if (!currentUser) return;
    let q;
    if (userProfile?.isAdmin) {
      q = query(collection(db, "transactions"), orderBy("createdAt", "desc"));
    } else {
      q = query(
        collection(db, "transactions"),
        where("participants", "array-contains", currentUser.uid)
      );
    }
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const txs = [];
      snapshot.forEach((docSnap) => {
        txs.push({ id: docSnap.id, ...docSnap.data() });
      });
      // ensure createdAt sorts even if timestamp types differ
      txs.sort((a, b) => {
        const aTime = a.createdAt?.toMillis
          ? a.createdAt.toMillis()
          : a.createdAt || 0;
        const bTime = b.createdAt?.toMillis
          ? b.createdAt.toMillis()
          : b.createdAt || 0;
        return bTime - aTime;
      });
      setTransactions(txs);
    });
    return () => unsubscribe();
  }, [currentUser, userProfile]);

  // Subscribe to in-app notifications for current user
  useEffect(() => {
    if (!currentUser) return;
    const notiCol = collection(db, "users", currentUser.uid, "notifications");
    const q = query(notiCol, orderBy("createdAt", "desc"));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const nots = [];
      let unread = 0;
      snapshot.forEach((d) => {
        const data = d.data();
        nots.push({ id: d.id, ...data });
        if (!data.read) unread++;
      });
      setNotifications(nots);
      setUnreadCount(unread);
    });
    return () => unsubscribe();
  }, [currentUser]);

  /* === Helpers: notifications and audit logs === */
  const createNotification = async (recipientUid, message, txId = null) => {
    try {
      await addDoc(collection(db, "users", recipientUid, "notifications"), {
        message,
        txId,
        read: false,
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      // don't crash the app for notification failures
      console.error("Failed to create notification", err);
    }
  };

  const addAuditLog = async (txId, actorUid, action, meta = {}) => {
    try {
      await addDoc(collection(db, "transactions", txId, "audit"), {
        actor: actorUid,
        action,
        meta,
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      console.error("Failed to add audit log", err);
    }
  };

  /* === Authentication handlers === */
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
        setAuthError(error.message || "An error occurred. Please try again.");
      }
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
  };

  /* === Transaction flow (creation, accept, status changes) === */

  const createTransaction = async (e) => {
    e.preventDefault();
    try {
      const invitedUserEntry = Object.entries(allUsers).find(
        ([_, u]) => u.email.toLowerCase() === txForm.inviteEmail.toLowerCase()
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
        createdAt: serverTimestamp(),
        participants: [currentUser.uid, invitedUid],
        paymentSent: false,
        paymentReceived: false,
        goodsReleased: false,
        buyerApproved: false,
        completed: false,
      };

      await setDoc(doc(db, "transactions", txId), txData);

      // Audit + notification
      await addAuditLog(txId, currentUser.uid, "created_transaction", {
        role: txForm.role,
        amount: txForm.amount,
        currency: txForm.currency,
      });
      await createNotification(
        invitedUid,
        `${userProfile.username} invited you to an escrow (${txId})`,
        txId
      );

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
    try {
      const txRef = doc(db, "transactions", txId);
      const txSnap = await getDoc(txRef);
      if (!txSnap.exists()) return;
      const tx = txSnap.data();

      await updateDoc(txRef, {
        status: "waiting_payment",
        sellerWallet:
          tx.invitedRole === "seller" ? userProfile.wallet : tx.sellerWallet,
        buyerWallet:
          tx.invitedRole === "buyer" ? userProfile.wallet : tx.buyerWallet,
      });

      await addAuditLog(txId, currentUser.uid, "accepted_transaction", {});
      // notify creator
      await createNotification(
        tx.creator,
        `${userProfile.username} accepted the escrow (${txId}).`,
        txId
      );
    } catch (err) {
      console.error(err);
    }
  };

  const markPaymentSent = async (txId) => {
    try {
      await updateDoc(doc(db, "transactions", txId), {
        paymentSent: true,
        status: "awaiting_confirmation",
      });
      await addAuditLog(txId, currentUser.uid, "marked_payment_sent", {});
      const txSnap = await getDoc(doc(db, "transactions", txId));
      const tx = txSnap.data();
      // notify admin and other party
      const other = tx.creator === currentUser.uid ? tx.invited : tx.creator;
      if (userProfile?.isAdmin) {
        // admin marking is handled separately
      } else {
        await createNotification(
          other,
          `${userProfile.username} marked payment as sent for ${txId}`,
          txId
        );
        // admin notification - find admin UIDs (simple approach: alert all users with isAdmin true)
        const adminIds = Object.entries(allUsers)
          .filter(([uid, u]) => u.isAdmin)
          .map(([uid]) => uid);
        for (const aid of adminIds) {
          await createNotification(
            aid,
            `Payment marked as sent for ${txId}. Please verify.`,
            txId
          );
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  const markPaymentReceived = async (txId) => {
    try {
      await updateDoc(doc(db, "transactions", txId), {
        paymentReceived: true,
        status: "payment_received",
      });
      await addAuditLog(txId, currentUser.uid, "admin_confirmed_payment", {});
      const txSnap = await getDoc(doc(db, "transactions", txId));
      const tx = txSnap.data();
      // notify both parties
      for (const p of tx.participants) {
        await createNotification(
          p,
          `Admin confirmed payment received for ${txId}`,
          txId
        );
      }
    } catch (err) {
      console.error(err);
    }
  };

  const markGoodsReleased = async (txId) => {
    try {
      await updateDoc(doc(db, "transactions", txId), {
        goodsReleased: true,
        status: "goods_released",
      });
      await addAuditLog(txId, currentUser.uid, "marked_goods_released", {});
      const txSnap = await getDoc(doc(db, "transactions", txId));
      const tx = txSnap.data();
      // notify buyer
      const buyer = tx.creatorRole === "buyer" ? tx.creator : tx.invited;
      await createNotification(
        buyer,
        `Seller released goods for ${txId}`,
        txId
      );
    } catch (err) {
      console.error(err);
    }
  };

  const approveFunds = async (txId) => {
    try {
      await updateDoc(doc(db, "transactions", txId), {
        buyerApproved: true,
        completed: true,
        status: "completed",
      });
      await addAuditLog(txId, currentUser.uid, "buyer_approved_release", {});
      const txSnap = await getDoc(doc(db, "transactions", txId));
      const tx = txSnap.data();
      // notify seller
      const seller = tx.creatorRole === "seller" ? tx.creator : tx.invited;
      await createNotification(
        seller,
        `Buyer approved release for ${txId}. Funds released.`,
        txId
      );
    } catch (err) {
      console.error(err);
    }
  };

  const rejectTransaction = async (txId) => {
    try {
      await updateDoc(doc(db, "transactions", txId), {
        status: "rejected",
      });
      await addAuditLog(txId, currentUser.uid, "rejected_transaction", {});
      // notify other party
      const txSnap = await getDoc(doc(db, "transactions", txId));
      const tx = txSnap.data();
      const other = tx.creator === currentUser.uid ? tx.invited : tx.creator;
      await createNotification(
        other,
        `${userProfile.username} rejected transaction ${txId}`,
        txId
      );
    } catch (err) {
      console.error(err);
    }
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

  // Admin: mark under review
  const markUnderReview = async (txId, reason = "") => {
    try {
      await updateDoc(doc(db, "transactions", txId), {
        status: "under_review",
      });
      await addAuditLog(txId, currentUser.uid, "marked_under_review", {
        reason,
      });
      const txSnap = await getDoc(doc(db, "transactions", txId));
      const tx = txSnap.data();
      for (const p of tx.participants) {
        await createNotification(
          p,
          `Admin marked ${txId} as Under Review.`,
          txId
        );
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Admin: refund
  const markRefunded = async (txId, reason = "") => {
    try {
      await updateDoc(doc(db, "transactions", txId), {
        status: "refunded",
        completed: false,
      });
      await addAuditLog(txId, currentUser.uid, "marked_refunded", { reason });
      const txSnap = await getDoc(doc(db, "transactions", txId));
      const tx = txSnap.data();
      for (const p of tx.participants) {
        await createNotification(p, `Admin marked ${txId} as Refunded.`, txId);
      }
    } catch (err) {
      console.error(err);
    }
  };

  /* === Utility: status label formatting, progress bar === */
  const prettyStatus = (s) => (s ? s.replace(/_/g, " ").toUpperCase() : "");
  const statusProgress = (s) => STATUS_PROGRESS[s] ?? 0;

  /* === UI: computed lists (search, filter, pagination) === */
  const filteredTxs = transactions.filter((tx) => {
    // filter by status
    if (filterStatus !== "all" && tx.status !== filterStatus) return false;
    // search by id or other username
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const otherUid = tx.creator === currentUser?.uid ? tx.invited : tx.creator;
    const other =
      allUsers[otherUid]?.username || allUsers[otherUid]?.email || "";
    return (
      (tx.id && tx.id.toLowerCase().includes(q)) ||
      (other && other.toLowerCase().includes(q)) ||
      (tx.terms && tx.terms.toLowerCase().includes(q))
    );
  });

  const totalPages = Math.max(1, Math.ceil(filteredTxs.length / itemsPerPage));
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [totalPages]);

  const paginatedTxs = filteredTxs.slice(
    (page - 1) * itemsPerPage,
    page * itemsPerPage
  );

  /* === Admin: view audit logs for a tx (modal) === */
  const openAuditModal = async (txId) => {
    try {
      setAuditModal({ open: true, txId, logs: [] });
      const auditCol = collection(db, "transactions", txId, "audit");
      const snap = await getDocs(query(auditCol, orderBy("createdAt", "desc")));
      const logs = [];
      snap.forEach((d) => {
        logs.push({ id: d.id, ...d.data() });
      });
      setAuditModal({ open: true, txId, logs });
    } catch (err) {
      console.error(err);
      setAuditModal({ open: true, txId, logs: [] });
    }
  };

  const closeAuditModal = () =>
    setAuditModal({ open: false, txId: null, logs: [] });

  /* === Notification helpers (mark read) === */
  const markNotificationRead = async (notId) => {
    try {
      await updateDoc(
        doc(db, "users", currentUser.uid, "notifications", notId),
        {
          read: true,
        }
      );
    } catch (err) {
      console.error(err);
    }
  };

  const markAllNotificationsRead = async () => {
    try {
      const notsSnap = await getDocs(
        collection(db, "users", currentUser.uid, "notifications")
      );
      const promises = [];
      notsSnap.forEach((d) => {
        if (!d.data().read) {
          promises.push(
            updateDoc(
              doc(db, "users", currentUser.uid, "notifications", d.id),
              { read: true }
            )
          );
        }
      });
      await Promise.all(promises);
    } catch (err) {
      console.error(err);
    }
  };

  /* === Profile editing (username, wallet, password) === */
  const saveProfile = async () => {
    setProfileMessage("");
    try {
      const updates = {};
      if (editUsername && editUsername !== userProfile.username)
        updates.username = editUsername;
      if (editWallet && editWallet !== userProfile.wallet)
        updates.wallet = editWallet;
      if (Object.keys(updates).length > 0) {
        await updateDoc(doc(db, "users", currentUser.uid), updates);
        setProfileMessage("Profile updated.");
        // refresh local
        const docSnap = await getDoc(doc(db, "users", currentUser.uid));
        setUserProfile(docSnap.data());
      }
    } catch (err) {
      console.error(err);
      setProfileMessage("Failed to update profile: " + (err.message || ""));
    }
  };

  const changePassword = async () => {
    setProfileMessage("");
    try {
      if (!currentPasswordForReauth || !newPassword) {
        setProfileMessage("Enter current and new password.");
        return;
      }
      // Re-authenticate
      const credential = EmailAuthProvider.credential(
        currentUser.email,
        currentPasswordForReauth
      );
      await reauthenticateWithCredential(currentUser, credential);
      // Update password
      await updatePassword(currentUser, newPassword);
      setProfileMessage("Password updated.");
      setCurrentPasswordForReauth("");
      setNewPassword("");
    } catch (err) {
      console.error(err);
      setProfileMessage("Password change failed: " + (err.message || ""));
    }
  };

  /* === Permissions & utility === */
  const canDeleteTransaction = (tx) => {
    const deletableStatuses = [
      "rejected",
      "pending_acceptance",
      "waiting_payment",
      "awaiting_confirmation",
    ];
    return deletableStatuses.includes(tx.status);
  };
  const isAdmin = userProfile?.isAdmin || false;

  /* === Loading UI === */
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Loader2 className="w-12 h-12 text-indigo-600 animate-spin" />
      </div>
    );
  }

  /* === Auth page === */
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
                  placeholder="Your Wallet Address (BTC/BCH/ETH)"
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

  /* === Navigation component === */
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
          <div className="relative">
            <button
              onClick={() => setCurrentPage("notifications")}
              className="px-3 py-2 rounded-lg hover:bg-gray-100"
            >
              🔔{" "}
              {unreadCount > 0 && (
                <span className="ml-1 inline-block bg-red-600 text-white text-xs px-2 py-0.5 rounded-full">
                  {unreadCount}
                </span>
              )}
            </button>
          </div>

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

  /* === Notifications Page === */
  if (currentPage === "notifications") {
    return (
      <div className="min-h-screen bg-gray-50">
        <Navigation />
        <div className="max-w-4xl mx-auto p-6">
          <button
            onClick={() => {
              setCurrentPage("dashboard");
            }}
            className="mb-6 text-indigo-600 hover:text-indigo-700"
          >
            ← Back
          </button>
          <div className="bg-white rounded-xl shadow-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold">Notifications</h2>
              <div>
                <button
                  onClick={markAllNotificationsRead}
                  className="px-3 py-1 bg-indigo-600 text-white rounded-lg"
                >
                  Mark all read
                </button>
              </div>
            </div>
            <div className="space-y-3">
              {notifications.length === 0 && (
                <p className="text-gray-500">No notifications</p>
              )}
              {notifications.map((n) => (
                <div
                  key={n.id}
                  className={`p-3 rounded-lg border ${
                    n.read ? "bg-gray-50" : "bg-white border-indigo-100"
                  }`}
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="text-sm text-gray-700">{n.message}</p>
                      {n.txId && (
                        <p className="text-xs text-gray-500 mt-1">
                          Tx: {n.txId}
                        </p>
                      )}
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-gray-400">
                        {n.createdAt?.toDate
                          ? n.createdAt.toDate().toLocaleString()
                          : ""}
                      </p>
                      {!n.read && (
                        <button
                          onClick={() => markNotificationRead(n.id)}
                          className="mt-2 text-xs text-indigo-600"
                        >
                          Mark read
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* === Dashboard (user view) === */
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

          <div className="flex gap-4 mb-6 items-center">
            <div className="flex items-center gap-2 bg-white p-2 rounded-lg shadow-sm">
              <Search className="w-4 h-4 text-gray-400" />
              <input
                placeholder="Search by tx id, username, or terms"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                className="outline-none px-2 py-1"
              />
            </div>

            <select
              value={filterStatus}
              onChange={(e) => {
                setFilterStatus(e.target.value);
                setPage(1);
              }}
              className="px-3 py-2 rounded-lg border bg-white"
            >
              <option value="all">All statuses</option>
              <option value="pending_acceptance">Pending Acceptance</option>
              <option value="waiting_payment">Waiting Payment</option>
              <option value="awaiting_confirmation">
                Awaiting Confirmation
              </option>
              <option value="payment_received">Payment Received</option>
              <option value="goods_released">Goods Released</option>
              <option value="completed">Completed</option>
              <option value="under_review">Under Review</option>
              <option value="refunded">Refunded</option>
              <option value="rejected">Rejected</option>
            </select>

            <div className="ml-auto flex items-center gap-2">
              <label className="text-sm text-gray-600">Per page</label>
              <select
                value={itemsPerPage}
                onChange={(e) => {
                  setItemsPerPage(parseInt(e.target.value));
                  setPage(1);
                }}
                className="px-2 py-1 border rounded"
              >
                <option value={5}>5</option>
                <option value={8}>8</option>
                <option value={12}>12</option>
              </select>
            </div>
          </div>

          {filteredTxs.length === 0 ? (
            <div className="bg-white rounded-xl shadow-sm p-12 text-center">
              <h3 className="text-xl font-semibold text-gray-700 mb-2">
                No transactions found
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
              {paginatedTxs.map((tx) => {
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
                      <div style={{ flex: 1 }}>
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
                            {prettyStatus(tx.status)}
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

                        {/* Progress bar */}
                        <div className="mt-3">
                          <div className="w-full bg-gray-200 rounded-full h-2">
                            <div
                              style={{ width: `${statusProgress(tx.status)}%` }}
                              className="h-2 rounded-full bg-indigo-600 transition-all"
                            />
                          </div>
                          <p className="text-xs text-gray-500 mt-1">
                            {statusProgress(tx.status)}% complete
                          </p>
                        </div>
                      </div>

                      <div className="text-right ml-6">
                        <p className="text-2xl font-bold text-indigo-600">
                          {tx.amount} {tx.currency}
                        </p>
                      </div>
                    </div>

                    <div className="flex gap-3 mt-4">
                      <button
                        onClick={() => {
                          setSelectedTx(tx);
                          setCurrentPage("details");
                        }}
                        className="flex-1 bg-indigo-600 text-white py-3 rounded-lg font-medium hover:bg-indigo-700 transition flex items-center justify-center gap-2"
                      >
                        View Details <ArrowRight className="w-4 h-4" />
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

          {/* Pagination */}
          <div className="mt-6 flex items-center justify-between">
            <div className="text-sm text-gray-600">
              Showing{" "}
              {filteredTxs.length === 0 ? 0 : (page - 1) * itemsPerPage + 1} -{" "}
              {Math.min(page * itemsPerPage, filteredTxs.length)} of{" "}
              {filteredTxs.length}
            </div>
            <div className="flex items-center gap-2">
              <button
                disabled={page === 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-3 py-1 bg-white border rounded disabled:opacity-50"
              >
                Prev
              </button>
              <div className="px-3 py-1 bg-white border rounded">
                Page {page} / {totalPages}
              </div>
              <button
                disabled={page === totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="px-3 py-1 bg-white border rounded disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* === Create Transaction page === */
  if (currentPage === "create") {
    return (
      <div className="min-h-screen bg-gray-50">
        <Navigation />
        <div className="max-w-3xl mx-auto p-6">
          <div className="bg-white rounded-xl shadow-sm p-8">
            <h2 className="text-3xl font-bold text-gray-800 mb-6">
              Create New Transaction
            </h2>

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
                    resolution. Only what's written here will be considered by
                    admin if disputes arise.
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
                    placeholder="Amount"
                    value={txForm.amount}
                    onChange={(e) =>
                      setTxForm({ ...txForm, amount: e.target.value })
                    }
                    className="w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Enter the exact amount (in selected currency)
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
                  >
                    <option value="BTC">BTC</option>
                    <option value="BCH">BCH</option>
                    <option value="ETH">ETH</option>
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
                  placeholder="Be specific! Include delivery details, condition, timeline, refunds..."
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

  /* === Transaction Details page (both user and admin) === */
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
                  {prettyStatus(tx.status)}
                </span>

                {isAdmin && (
                  <button
                    onClick={() => openAuditModal(tx.id)}
                    className="bg-indigo-100 text-indigo-700 px-3 py-2 rounded-lg"
                  >
                    View Audit
                  </button>
                )}
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
                    <strong>First, try to resolve with the other party.</strong>{" "}
                    If you cannot reach an agreement, contact admin on Signal.
                  </p>
                  <p className="text-sm font-mono text-blue-900 bg-white px-3 py-2 rounded inline-block">
                    Signal: {ADMIN_SIGNAL}
                  </p>
                  <p className="text-xs text-blue-600 mt-2">
                    <strong>For disputes:</strong> Provide clear proof
                    (screenshots, tracking numbers, photos) and reference the
                    transaction terms below.
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
                      {allUsers[sellerUid]?.username || sellerUid}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-600">Buyer</p>
                    <p className="font-medium">
                      {allUsers[buyerUid]?.username || buyerUid}
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
                {/* Several progress steps, using the tx flags */}
                <StepIndicator
                  label="Transaction Accepted"
                  done={tx.status !== "pending_acceptance"}
                />
                <StepIndicator
                  label="Seller Marked Payment Sent"
                  done={tx.paymentSent}
                  loading={!tx.paymentSent && tx.status === "waiting_payment"}
                />
                <StepIndicator
                  label="Admin Confirmed Payment"
                  done={tx.paymentReceived}
                  loading={!tx.paymentReceived && tx.paymentSent}
                />
                <StepIndicator
                  label="Seller Released Goods/Services"
                  done={tx.goodsReleased}
                  loading={!tx.goodsReleased && tx.paymentReceived}
                />
                <StepIndicator
                  label="Buyer Approved & Funds Released"
                  done={tx.completed}
                  loading={!tx.completed && tx.goodsReleased}
                />
              </div>
            </div>

            <div className="space-y-4">
              {/* Accept / Reject */}
              {tx.status === "pending_acceptance" && !isCreator && (
                <div className="flex gap-4">
                  <button
                    onClick={() => acceptTransaction(tx.id)}
                    className="flex-1 bg-green-600 text-white py-3 rounded-lg font-medium hover:bg-green-700 transition flex items-center justify-center gap-2"
                  >
                    <Check className="w-5 h-5" /> Accept Transaction
                  </button>
                  <button
                    onClick={() => rejectTransaction(tx.id)}
                    className="flex-1 bg-red-600 text-white py-3 rounded-lg font-medium hover:bg-red-700 transition flex items-center justify-center gap-2"
                  >
                    <X className="w-5 h-5" /> Reject
                  </button>
                </div>
              )}

              {/* Seller send payment */}
              {tx.status === "waiting_payment" &&
                isSeller &&
                !tx.paymentSent && (
                  <div className="space-y-4">
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
                      <p className="font-semibold text-blue-800 mb-2">
                        💰 Send Payment to Escrow
                      </p>
                      <p className="text-blue-700 mb-3">
                        Send{" "}
                        <strong>
                          {tx.amount} {tx.currency}
                        </strong>{" "}
                        to the escrow wallet address shown above. Once you've
                        sent the payment, mark it as sent below. Admin will
                        verify the transaction on the blockchain and confirm
                        receipt.
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

              {/* Waiting seller send */}
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

              {/* Awaiting admin */}
              {(tx.status === "awaiting_confirmation" ||
                (tx.paymentSent && !tx.paymentReceived)) && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6">
                  <p className="font-semibold text-yellow-800 mb-2">
                    ⏳ Awaiting Admin Confirmation
                  </p>
                  <p className="text-yellow-700">
                    {isSeller && "You've marked the payment as sent. "}Admin
                    will verify the payment on the blockchain. This usually
                    takes a few minutes to a few hours.
                  </p>
                </div>
              )}

              {/* Payment received: seller release */}
              {tx.status === "payment_received" &&
                isSeller &&
                !tx.goodsReleased && (
                  <div className="space-y-4">
                    <div className="bg-green-50 border border-green-200 rounded-lg p-6">
                      <p className="font-semibold text-green-800 mb-2">
                        ✅ Payment Confirmed in Escrow!
                      </p>
                      <p className="text-green-700">
                        Admin has confirmed your payment is in escrow. Now
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

              {/* Payment received: buyer view */}
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

              {/* Goods released: buyer approve */}
              {tx.status === "goods_released" &&
                isBuyer &&
                !tx.buyerApproved && (
                  <div className="space-y-4">
                    <div className="bg-green-50 border border-green-200 rounded-lg p-6">
                      <p className="font-semibold text-green-800 mb-2">
                        📦 Goods/Services Released!
                      </p>
                      <p className="text-green-700 mb-3">
                        Inspect everything carefully. If all good, approve the
                        transaction to release funds. If there's an issue,
                        contact the seller first; then contact admin if needed.
                      </p>
                      <p className="text-green-600 text-sm">
                        If everything is as described, approve to release funds.
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

              {/* Goods released: seller awaiting */}
              {tx.status === "goods_released" &&
                isSeller &&
                !tx.buyerApproved && (
                  <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6">
                    <p className="font-semibold text-yellow-800 mb-2">
                      ⏳ Awaiting Buyer Approval
                    </p>
                    <p className="text-yellow-700">
                      Waiting for the buyer to inspect and approve. Once
                      approved, funds will be released to your wallet.
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

              {tx.status === "under_review" && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6">
                  <p className="font-semibold text-yellow-800 mb-2">
                    🔍 Under Review by Admin
                  </p>
                  <p className="text-yellow-700">
                    Admin is reviewing this transaction. You will be notified of
                    any outcomes (refund / proceed) via notifications.
                  </p>
                </div>
              )}

              {tx.status === "refunded" && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-6">
                  <p className="font-semibold text-red-800 mb-2">💸 Refunded</p>
                  <p className="text-red-700">
                    This transaction was marked refunded by admin. Please check
                    communications for details.
                  </p>
                </div>
              )}

              {/* Admin actions (on details page) */}
              {isAdmin && (
                <div className="mt-4 grid grid-cols-3 gap-3">
                  <button
                    onClick={() => markPaymentReceived(tx.id)}
                    className="px-3 py-2 bg-green-600 text-white rounded"
                  >
                    Confirm Payment Received
                  </button>
                  <button
                    onClick={() => {
                      const reason = prompt(
                        "Reason (optional) for marking under review:"
                      );
                      markUnderReview(tx.id, reason);
                    }}
                    className="px-3 py-2 bg-yellow-500 text-white rounded"
                  >
                    Mark Under Review
                  </button>
                  <button
                    onClick={() => {
                      const reason = prompt("Reason (optional) for refund:");
                      markRefunded(tx.id, reason);
                    }}
                    className="px-3 py-2 bg-red-500 text-white rounded"
                  >
                    Mark Refunded
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Audit modal for admin */}
        {auditModal.open && isAdmin && (
          <div className="fixed inset-0 flex items-center justify-center bg-black/40 p-6">
            <div className="bg-white rounded-lg w-full max-w-2xl p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-bold">Audit logs for {auditModal.txId}</h3>
                <button onClick={closeAuditModal} className="text-gray-600">
                  Close
                </button>
              </div>
              <div className="space-y-3 max-h-80 overflow-auto">
                {auditModal.logs.length === 0 && (
                  <p className="text-gray-500">No audit logs yet.</p>
                )}
                {auditModal.logs.map((l) => (
                  <div key={l.id} className="p-3 border rounded">
                    <div className="flex justify-between">
                      <div>
                        <p className="text-sm text-gray-700">{l.action}</p>
                        <p className="text-xs text-gray-500">
                          {l.actor
                            ? allUsers[l.actor]?.username || l.actor
                            : "system"}
                        </p>
                      </div>
                      <div className="text-right text-xs text-gray-400">
                        {l.createdAt?.toDate
                          ? l.createdAt.toDate().toLocaleString()
                          : ""}
                      </div>
                    </div>
                    {l.meta && Object.keys(l.meta).length > 0 && (
                      <pre className="text-xs text-gray-500 mt-2">
                        {JSON.stringify(l.meta)}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  /* === Admin Panel === */
  if (currentPage === "admin" && isAdmin) {
    const allTxs = transactions.sort((a, b) => {
      const aTime = a.createdAt?.toMillis
        ? a.createdAt.toMillis()
        : a.createdAt || 0;
      const bTime = b.createdAt?.toMillis
        ? b.createdAt.toMillis()
        : b.createdAt || 0;
      return bTime - aTime;
    });

    return (
      <div className="min-h-screen bg-gray-50">
        <Navigation />
        <div className="max-w-7xl mx-auto p-6">
          <div className="mb-8">
            <h2 className="text-3xl font-bold text-gray-800 mb-2">
              Admin Panel
            </h2>
            <p className="text-gray-600">
              Confirm escrow payments, manage disputes, and view audit trails
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
                      {prettyStatus(tx.status)}
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

                  {/* Admin controls */}
                  <div className="flex gap-3 items-center">
                    {tx.paymentSent && !tx.paymentReceived && (
                      <>
                        <div className="flex-1">
                          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-3">
                            <p className="text-sm text-yellow-800">
                              ⚠️ Seller marked payment as sent. Verify{" "}
                              {tx.amount} {tx.currency} has been received at
                              escrow wallet.
                            </p>
                          </div>
                        </div>
                        <button
                          onClick={() => markPaymentReceived(tx.id)}
                          className="bg-green-600 text-white px-6 py-2 rounded-lg font-medium hover:bg-green-700 transition"
                        >
                          ✓ Confirm Payment Received
                        </button>
                      </>
                    )}

                    {tx.paymentReceived && (
                      <div className="mt-2 bg-green-50 border border-green-200 rounded-lg p-3">
                        <p className="text-sm text-green-700">
                          ✓ Payment confirmed in escrow
                        </p>
                      </div>
                    )}

                    {!tx.paymentSent && tx.status === "waiting_payment" && (
                      <div className="mt-2 bg-gray-50 border border-gray-200 rounded-lg p-3">
                        <p className="text-sm text-gray-600">
                          Waiting for seller to send payment to escrow...
                        </p>
                      </div>
                    )}

                    {/* Quick actions */}
                    <div className="ml-auto flex items-center gap-2">
                      <button
                        onClick={() => openAuditModal(tx.id)}
                        className="px-3 py-2 bg-indigo-100 text-indigo-700 rounded"
                      >
                        View Audit
                      </button>
                      <button
                        onClick={() => {
                          const reason = prompt(
                            "Reason (optional) for refund:"
                          );
                          markRefunded(tx.id, reason);
                        }}
                        className="px-3 py-2 bg-red-500 text-white rounded"
                      >
                        Refund
                      </button>
                      <button
                        onClick={() => {
                          const reason = prompt(
                            "Reason (optional) for under review:"
                          );
                          markUnderReview(tx.id, reason);
                        }}
                        className="px-3 py-2 bg-yellow-500 text-white rounded"
                      >
                        Under Review
                      </button>
                    </div>
                  </div>
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

        {/* audit modal reused for admin list as well */}
        {auditModal.open && isAdmin && (
          <div className="fixed inset-0 flex items-center justify-center bg-black/40 p-6">
            <div className="bg-white rounded-lg w-full max-w-2xl p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-bold">Audit logs for {auditModal.txId}</h3>
                <button onClick={closeAuditModal} className="text-gray-600">
                  Close
                </button>
              </div>
              <div className="space-y-3 max-h-80 overflow-auto">
                {auditModal.logs.length === 0 && (
                  <p className="text-gray-500">No audit logs yet.</p>
                )}
                {auditModal.logs.map((l) => (
                  <div key={l.id} className="p-3 border rounded">
                    <div className="flex justify-between">
                      <div>
                        <p className="text-sm text-gray-700">{l.action}</p>
                        <p className="text-xs text-gray-500">
                          {l.actor
                            ? allUsers[l.actor]?.username || l.actor
                            : "system"}
                        </p>
                      </div>
                      <div className="text-right text-xs text-gray-400">
                        {l.createdAt?.toDate
                          ? l.createdAt.toDate().toLocaleString()
                          : ""}
                      </div>
                    </div>
                    {l.meta && Object.keys(l.meta).length > 0 && (
                      <pre className="text-xs text-gray-500 mt-2">
                        {JSON.stringify(l.meta)}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  /* === Profile page (accessible via route /profile or additional nav - quick access by changing currentPage === 'profile') === */
  if (currentPage === "profile") {
    return (
      <div className="min-h-screen bg-gray-50">
        <Navigation />
        <div className="max-w-3xl mx-auto p-6">
          <button
            onClick={() => setCurrentPage("dashboard")}
            className="mb-6 text-indigo-600 hover:text-indigo-700"
          >
            ← Back
          </button>
          <div className="bg-white rounded-xl shadow-sm p-8">
            <h2 className="text-2xl font-bold mb-4">Profile</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">
                  Username
                </label>
                <input
                  value={editUsername}
                  onChange={(e) => setEditUsername(e.target.value)}
                  placeholder={userProfile?.username || ""}
                  className="w-full px-4 py-2 border rounded mt-1"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">
                  Wallet
                </label>
                <input
                  value={editWallet}
                  onChange={(e) => setEditWallet(e.target.value)}
                  placeholder={userProfile?.wallet || ""}
                  className="w-full px-4 py-2 border rounded mt-1"
                />
              </div>
              <div className="flex gap-3">
                <button
                  onClick={saveProfile}
                  className="px-4 py-2 bg-indigo-600 text-white rounded"
                >
                  Save Profile
                </button>
                <button
                  onClick={() => {
                    setEditUsername(userProfile?.username || "");
                    setEditWallet(userProfile?.wallet || "");
                  }}
                  className="px-4 py-2 border rounded"
                >
                  Reset
                </button>
              </div>

              <hr className="my-4" />

              <h3 className="text-lg font-semibold">Change Password</h3>
              <p className="text-sm text-gray-500 mb-2">
                You must enter your current password to change it
                (reauthentication required).
              </p>
              <div>
                <label className="block text-sm text-gray-600">
                  Current Password
                </label>
                <input
                  type="password"
                  value={currentPasswordForReauth}
                  onChange={(e) => setCurrentPasswordForReauth(e.target.value)}
                  className="w-full px-4 py-2 border rounded mt-1"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600">
                  New Password
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-4 py-2 border rounded mt-1"
                />
              </div>
              <div className="flex gap-3 mt-3">
                <button
                  onClick={changePassword}
                  className="px-4 py-2 bg-indigo-600 text-white rounded"
                >
                  Change Password
                </button>
              </div>

              {profileMessage && (
                <div className="mt-3 text-sm text-gray-700">
                  {profileMessage}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* Fallback: nothing matched */
  return null;
}

/* === Small helper component === */
function StepIndicator({ label, done, loading = false }) {
  return (
    <div className="flex items-center gap-3">
      <div
        className={`w-8 h-8 rounded-full flex items-center justify-center ${
          done ? "bg-green-500" : loading ? "bg-gray-400" : "bg-gray-300"
        }`}
      >
        {done ? (
          <Check className="w-5 h-5 text-white" />
        ) : loading ? (
          <Loader2 className="w-5 h-5 text-white animate-spin" />
        ) : (
          <div className="w-3 h-3 rounded-full bg-white/60" />
        )}
      </div>
      <p className="text-gray-700">{label}</p>
    </div>
  );
}
