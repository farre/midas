#pragma once

// Types to check if pretty printing works properly for all scenarios
#include <tuple>
#include <vector>
#include <string>
#include <iostream>

namespace prettyprinting {
    // These types are not meant to be good design.
    // In fact they're meant to be as convoluted as possible
    template <typename ...Ts>
    struct base_t {
        using base_tuple = std::tuple<Ts...>;
        base_t(base_tuple* t) : ts(t) {}
        base_t(base_t&&) = default;
        virtual ~base_t() {
            std::cout << "destroy base_t" << std::endl;
            if(ts)
                delete ts;
        }

        virtual void print_values() const = 0;
        base_tuple* ts = nullptr;
    };

    struct bank_account : public base_t<int, std::string, float> {
        bank_account(int, std::string, float);
        virtual ~bank_account() {}
        void print_values() const override;
    };

    struct person_t {
        person_t(int id, std::string name, bank_account* acc);
        virtual ~person_t() {
            delete account;
        }

        int id;
        std::string name;
        bank_account* account;
    };

    struct employee_t : public person_t {
        employee_t(int id, std::string name, bank_account* acc, std::string position);
        virtual ~employee_t() = default;
        std::string position;
    };

    void main();
}
