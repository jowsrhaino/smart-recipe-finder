import mongoose from "mongoose";

const ingredientSchema = new mongoose.Schema({
    name: { type: String, required: true },
    quantity: { type: Number, required: true },
    unit: { type: String, required: true },
    image: { type: String, default: "" }
}, { _id: false });

const pendingRecipeSchema = new mongoose.Schema({
    title: { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true },
    cuisine: { type: String, required: true, trim: true },
    baseServes: { type: Number, required: true },
    ingredients: [ingredientSchema],
    instructions: { type: String, required: true },
    image: { type: String, default: "" },
    youtube: { type: String, default: "" },
    status: {
        type: String,
        enum: ["pending"],
        default: "pending"
    },
    submittedByName: { type: String, default: "" },
    submittedByEmail: { type: String, default: "" },
    submittedByRole: {
        type: String,
        enum: ["user"],
        default: "user"
    },
    verificationMode: {
        type: String,
        enum: ["manual", "ai", "admin"],
        default: "manual"
    },
    verificationNote: { type: String, default: "" },
    aiReview: {
        decision: {
            type: String,
            enum: ["approve", "review", "reject", ""],
            default: ""
        },
        score: {
            type: Number,
            default: 0
        },
        summary: {
            type: String,
            default: ""
        },
        issues: {
            type: [String],
            default: []
        },
        checkedAt: {
            type: Date
        }
    }
}, { timestamps: true });

const PendingRecipe = mongoose.model("PendingRecipe", pendingRecipeSchema);

export default PendingRecipe;
