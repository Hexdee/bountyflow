#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env,
};

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Escrow,
    Completions(Address),
    Earned(Address),
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct Profile {
    pub completions: u32,
    pub earned: i128,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ReputationError {
    AlreadyInitialized = 1,
    UnauthorizedCaller = 2,
}

#[contract]
pub struct Reputation;

#[contractimpl]
impl Reputation {
    pub fn initialize(env: Env, escrow: Address) -> Result<(), ReputationError> {
        if env.storage().instance().has(&DataKey::Escrow) {
            return Err(ReputationError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Escrow, &escrow);
        Ok(())
    }

    pub fn record_completion(
        env: Env,
        caller: Address,
        builder: Address,
        bounty_id: u64,
        amount: i128,
    ) -> Result<(), ReputationError> {
        let escrow: Address = env.storage().instance().get(&DataKey::Escrow).unwrap();
        if caller != escrow {
            return Err(ReputationError::UnauthorizedCaller);
        }
        caller.require_auth();
        let completions: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::Completions(builder.clone()))
            .unwrap_or(0);
        let earned: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Earned(builder.clone()))
            .unwrap_or(0);
        env.storage().persistent().set(
            &DataKey::Completions(builder.clone()),
            &completions.saturating_add(1),
        );
        env.storage().persistent().set(
            &DataKey::Earned(builder.clone()),
            &earned.saturating_add(amount),
        );
        env.events()
            .publish((symbol_short!("complete"), builder, bounty_id), amount);
        Ok(())
    }

    pub fn get_profile(env: Env, builder: Address) -> Profile {
        Profile {
            completions: env
                .storage()
                .persistent()
                .get(&DataKey::Completions(builder.clone()))
                .unwrap_or(0),
            earned: env
                .storage()
                .persistent()
                .get(&DataKey::Earned(builder))
                .unwrap_or(0),
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    #[test]
    fn records_only_authorized_completions() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(Reputation, ());
        let client = ReputationClient::new(&env, &id);
        let escrow = Address::generate(&env);
        let builder = Address::generate(&env);
        client.initialize(&escrow);
        client.record_completion(&escrow, &builder, &7, &2500000);
        let profile = client.get_profile(&builder);
        assert_eq!(profile.completions, 1);
        assert_eq!(profile.earned, 2500000);
    }
}
