import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
    name:{
        type:String,
        required:true
    },
    email:{
        type: String,
        required: true,
        unique: true
    },
    password:{
        type: String,
        required: true
    },
    language: {
        type: String,
        required: true,
        default: "English",
        trim: true
    },
    emailVerified: {
        type: Boolean,
        default: false
    },
    emailVerificationToken: {
        type: String,
        default: ""
    },
    emailVerificationTokenExpiresAt: {
        type: Date
    },
    emailVerificationRequestedAt: {
        type: Date
    },
    premium: {
        type: Boolean,
        default: false
    },
    premiumActivatedAt: {
        type: Date
    },
    premiumExpiresAt: {
        type: Date
    },
    premiumStatus: {
        type: String,
        enum: ["none", "payment_pending_approval", "active", "expired", "revoked"],
        default: "none"
    },
    premiumRequestedAt: {
        type: Date
    },
    premiumPlanId: {
        type: String,
        default: ""
    },
    premiumPlanName: {
        type: String,
        default: ""
    },
    premiumDurationDays: {
        type: Number,
        default: 0
    },
    premiumAmount: {
        type: Number,
        default: 0
    },
    premiumCurrency: {
        type: String,
        default: ""
    },
    premiumGrantedBy: {
        type: String,
        default: ""
    },
    premiumRevokedAt: {
        type: Date
    },
    premiumRevokedBy: {
        type: String,
        default: ""
    },
    mealPlan: {
        type: [
            {
                key: { type: String, default: "" },
                title: { type: String, default: "" },
                day: { type: String, default: "" },
                time: { type: String, default: "" },
                serves: { type: Number, default: 1 },
                recipe: { type: Object, default: {} }
            }
        ],
        default: []
    }
    ,
    usedOneTimePlanIds: {
        type: [String],
        default: []
    }
   
   
}, { timestamps: true });
export const User = mongoose.model('User', userSchema);

export default User;
    
